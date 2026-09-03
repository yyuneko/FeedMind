import { describe, expect, it, vi } from "vitest";
import type { AccessIdentity } from "../../shared/src/auth";
import type { D1Database, D1PreparedStatement } from "../../shared/src/cloudflare";
import { routeClientApi, type ClientApiEnv } from "../src/routes";

const identity: AccessIdentity = { subject: "subject", email: "owner@example.com" };

describe("library navigation", () => {
  it("mirrors a newly added selected article into the C-end library source", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const batches: Array<Array<{ sql: string; bindings: unknown[] }>> = [];
    const DB = {
      prepare(sql: string) {
        const statement = {
          sql,
          bindings: [] as unknown[],
          bind(...values: unknown[]) { statement.bindings = values; statements.push(statement); return statement; },
          async first() {
            if (sql.includes("active_connection_id AS connectionId")) return { connectionId: "connection:direct-rss:account-1", revision: 1 };
            if (sql.includes("connector_type AS type")) return { id: "connection:direct-rss:account-1", type: "direct_rss" };
            if (sql.includes("SELECT a.id, a.feed_id")) return null;
            if (sql.includes("SELECT id FROM feeds")) return { id: "selected-feed" };
            if (sql.includes("INSERT INTO sources")) return { id: "selected-feed" };
            return null;
          },
          async all() { return { success: true, results: [] }; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch(items: Array<{ sql: string; bindings: unknown[] }>) { batches.push(items); return []; },
    } as unknown as D1Database;
    const queue = { send: vi.fn() };
    const response = await routeClientApi(new Request("https://api.example/v1/articles", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ URL: "https://example.com/selected", Title: "Selected article" }),
    }), { DB, ARTICLE_QUEUE: queue } as unknown as ClientApiEnv, "selected", identity, "account-1");

    expect(response?.status).toBe(202);
    expect(statements.some((statement) => statement.sql.includes("INSERT INTO sources")
      && statement.bindings.includes("connection:direct-rss:account-1"))).toBe(true);
    const sourceItem = batches.flat().find((statement) => statement.sql.includes("INSERT INTO source_items"));
    expect(sourceItem?.bindings).toEqual(expect.arrayContaining(["account-1", "connection:direct-rss:account-1", "selected-feed"]));
    expect(queue.send).toHaveBeenCalledOnce();
  });

  it("returns an exact localized article tag by key", async () => {
    const bindings: unknown[][] = [];
    const DB = {
      prepare(sql: string) {
        const statement = {
          bind(...values: unknown[]) { bindings.push(values); return statement; },
          async first() { return sql.includes("FROM topic_tags") ? { key: "artificial-intelligence", name: "人工智能" } : null; },
          async all() { return { success: true, results: [] }; },
          async run() { return { success: true, meta: { changes: 0 } }; },
        };
        return statement;
      },
      async batch() { return []; },
    } as unknown as D1Database;
    const response = await routeClientApi(new Request("https://api.example/v1/article-tags/artificial-intelligence?targetLocale=zh-CN"), { DB } as ClientApiEnv, "tag", identity, "account-1");
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ data: { key: "artificial-intelligence", name: "人工智能" } });
    expect(bindings.some((values) => values[0] === "artificial-intelligence" && values[1] === "zh-CN")).toBe(true);
  });

  it("matches tag counts against article summaries and key points", async () => {
    const sql: string[] = [];
    const DB = {
      prepare(statementSql: string) {
        sql.push(statementSql);
        const statement = {
          bind() { return statement; },
          async first() { return null; },
          async all() { return { success: true, results: [] }; },
          async run() { return { success: true, meta: { changes: 0 } }; },
        };
        return statement;
      },
      async batch() { return []; },
    } as unknown as D1Database;
    const response = await routeClientApi(new Request("https://api.example/v1/article-tags?query=agent&tagQuery=ai&excludeSelected=true"), { DB } as ClientApiEnv, "tags", identity, "account-1");
    expect(response?.status).toBe(200);
    const query = sql.find((value) => value.includes("COUNT(DISTINCT a.id)")) ?? "";
    expect(query).toContain("search_pl.one_line_summary LIKE ?8");
    expect(query).toContain("search_pl.key_points_json LIKE ?8");
    expect(query).toContain("selected_feed.url = 'feedmind://selected/owner'");
  });

  it("uses the server-side inclusive 30-day cutoff for recent articles", async () => {
    const articleBindings: unknown[][] = [];
    const articleSql: string[] = [];
    const DB = {
      prepare(sql: string) {
        const statement = {
          sql,
          bind(...values: unknown[]) {
            if (sql.includes("st.last_opened_at >= ?14")) { articleBindings.push(values); articleSql.push(sql); }
            return statement;
          },
          async first() { return { total: 0 }; },
          async all() { return { success: true, results: [] }; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch() { return []; },
    } as unknown as D1Database;
    const before = Date.now() - 30 * 24 * 60 * 60_000;
    const response = await routeClientApi(new Request("https://api.example/v1/articles?scope=recent"), { DB } as ClientApiEnv, "recent", identity, "account-1");
    const after = Date.now() - 30 * 24 * 60 * 60_000;
    expect(response?.status).toBe(200);
    expect(articleSql[0]).toContain("st.last_opened_at >= ?14");
    expect(articleBindings[0][12]).toBe(1);
    const cutoff = Date.parse(String(articleBindings[0][13]));
    expect(cutoff).toBeGreaterThanOrEqual(before - 1000);
    expect(cutoff).toBeLessThanOrEqual(after + 1000);
  });

  it("marks the first engaged activity read and records last_opened_at", async () => {
    const batches: D1PreparedStatement[][] = [];
    const DB = {
      prepare(sql: string) {
        const statement = {
          sql,
          bindings: [] as unknown[],
          bind(...values: unknown[]) { statement.bindings = values; return statement; },
          async first() {
            if (sql.trimStart().startsWith("SELECT active_connection_id AS connectionId")) return { connectionId: "connection:direct-rss:account-1", revision: 1 };
            if (sql.includes("connector_type AS type")) return { id: "connection:direct-rss:account-1", type: "direct_rss" };
            if (sql.includes("SELECT a.id FROM articles")) return { id: "article-1" };
            if (sql.includes("article_state_operations")) return null;
            if (sql.includes("reading_progress AS progress")) return { articleId: "article-1", isRead: 1, isStarred: 0, progress: 0.25, lastOpenedAt: "2026-09-01T00:00:00.000Z" };
            return null;
          },
          async all() { return { success: true, results: [] }; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch(statements: D1PreparedStatement[]) { batches.push(statements); return []; },
    } as unknown as D1Database;
    const response = await routeClientApi(new Request("https://api.example/v1/articles/article-1/reading-activity", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "session-1:engaged", sessionId: "session-1", kind: "engaged", progress: 0.25 }),
    }), { DB, FEED_QUEUE: { send: vi.fn() } } as unknown as ClientApiEnv, "engaged", identity, "account-1");
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ data: { articleId: "article-1", isRead: true, progress: 0.25 } });
    const stateStatement = batches.flat().find((statement: any) => statement.sql.includes("article_states")) as any;
    expect(batches.length).toBeGreaterThan(0);
    expect(stateStatement).toBeDefined();
  });

  it("moves feeds to Uncategorized before deleting a category", async () => {
    const sql: string[] = [];
    const DB = {
      prepare(statementSql: string) {
        sql.push(statementSql);
        const statement = { bind: () => statement, first: async () => ({ id: "category-1" }), all: async () => ({ success: true, results: [] }), run: async () => ({ success: true, meta: { changes: 1 } }) };
        return statement;
      },
      async batch() { return []; },
    } as unknown as D1Database;
    const response = await routeClientApi(new Request("https://api.example/v1/library/categories/category-1", { method: "DELETE" }), { DB } as ClientApiEnv, "delete", identity, "account-1");
    expect(response?.status).toBe(204);
    expect(sql.some((value) => value.includes("UPDATE sources SET library_category_id = NULL"))).toBe(true);
    expect(sql.some((value) => value.includes("DELETE FROM library_categories"))).toBe(true);
  });
});
