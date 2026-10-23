import { describe, expect, it, vi } from "vitest";
import type { AccessIdentity } from "../../shared/src/auth";
import type { D1Database, D1PreparedStatement } from "../../shared/src/cloudflare";
import { routeClientApi, type ClientApiEnv } from "../src/routes";

const identity: AccessIdentity = { subject: "subject", email: "owner@example.com" };

function database(firstResult: unknown): D1Database {
  const statement: D1PreparedStatement = {
    bind: () => statement,
    first: async <T>() => firstResult as T,
    all: async <T>() => ({ success: true, results: [] as T[] }),
    run: async () => ({ success: true, meta: { changes: 1 } }),
  };
  return {
    prepare: (sql) => sql.includes("FROM source_connections") && sql.includes("connector_type AS type")
      ? { ...statement, bind: () => ({ ...statement, first: async <T>() => ({ id: "connection:direct-rss:account-1", type: "direct_rss" }) as T }) }
      : sql.trimStart().startsWith("SELECT active_connection_id AS connectionId")
        ? { ...statement, bind: () => ({ ...statement, first: async <T>() => null as T }) }
      : sql.includes("FROM account_identities") && sql.includes("provider_subject")
      ? { ...statement, bind: () => ({ ...statement, first: async <T>() => ({ accountId: "account-1" }) as T }) }
      : statement,
    batch: async () => [],
  };
}

describe("C API business routes", () => {
  it("deletes only articles from the selected virtual feed", async () => {
    const sql: string[] = [];
    const DB = {
      prepare(statementSql: string) {
        sql.push(statementSql);
        const statement = {
          bind() { return statement; },
          async first() { return statementSql.includes("feed.url = 'feedmind://selected/owner'") ? { id: "article-1" } : null; },
          async all() { return { success: true, results: [] }; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch() { return []; },
    } as unknown as D1Database;
    const response = await routeClientApi(new Request("https://api.example/v1/articles/article-1", { method: "DELETE" }),
      { DB } as ClientApiEnv, "delete-selected", identity, "account-1");
    expect(response?.status).toBe(204);
    expect(sql.some((statement) => statement.startsWith("DELETE FROM articles"))).toBe(true);
  });

  it("refuses to delete a regular subscription article", async () => {
    const DB = database(null);
    await expect(routeClientApi(new Request("https://api.example/v1/articles/article-1", { method: "DELETE" }),
      { DB } as ClientApiEnv, "delete-regular", identity, "account-1"))
      .rejects.toMatchObject({ status: 404, code: "selected_article_not_found" });
  });

  it("authorizes a signed-in account and redirects with a one-time OAuth code", async () => {
    const statements: string[] = [];
    const DB = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind() { return statement; },
          async first() { return null; },
          async all() { return { success: true, results: [] }; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch() { return []; },
    } as unknown as D1Database;
    const redirectUri = "https://chatgpt.com/aip/g-test/oauth/callback";
    const request = new Request(`https://api.example/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: "feedmind-chatgpt-action", redirect_uri: redirectUri,
      scope: "feedmind.read feedmind.write offline_access", state: "state-1",
    })}`);
    const response = await routeClientApi(request, {
      DB, GPT_OAUTH_CLIENT_ID: "feedmind-chatgpt-action", GPT_OAUTH_REDIRECT_URIS: redirectUri,
    } as unknown as ClientApiEnv, "oauth-authorize", identity, "account-1");
    expect(response?.status).toBe(302);
    const location = new URL(response!.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("code")).toMatch(/^fm_oauth_code_/);
    expect(location.searchParams.get("iss")).toBe("https://actions.feedmind.cc");
    expect(statements.some((sql) => sql.includes("INSERT INTO gpt_oauth_authorization_codes"))).toBe(true);
  });

  it("accepts the stable ChatGPT Connector OAuth callback", async () => {
    const DB = database(null);
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const request = new Request(`https://api.example/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: "feedmind-chatgpt-action", redirect_uri: redirectUri,
      scope: "feedmind.read", state: "connector-state", code_challenge: "a".repeat(43), code_challenge_method: "S256",
    })}`);
    const response = await routeClientApi(request, {
      DB, GPT_OAUTH_CLIENT_ID: "feedmind-chatgpt-action", GPT_OAUTH_REDIRECT_URIS: "https://legacy.example/callback",
    } as unknown as ClientApiEnv, "oauth-connector", identity, "account-1");
    expect(response?.status).toBe(302);
    const location = new URL(response!.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get("iss")).toBe("https://actions.feedmind.cc");
  });

  it("returns the article title translated for the requested client locale", async () => {
    const listBindings = vi.fn();
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = {
            bind(...values: unknown[]) {
              if (sql.includes("article_title_translations")) listBindings(...values);
              return statement;
            },
            async first() { return { total: 1 }; },
            async all() {
              return { success: true, results: sql.includes("article_title_translations") ? [{
                id: "article-1", title: "Original title", translatedTitle: "翻訳タイトル",
                sourceTitleLocale: "en-US", translatedTitleLocale: "ja-JP",
                parseStatus: "error", parseError: "request_timeout", isRead: 0, isStarred: 0,
              }] : [] };
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
          return statement;
        },
        async batch() { return []; },
      },
    } as unknown as ClientApiEnv;
    const response = await routeClientApi(
      new Request("https://api.example/v1/articles?targetLocale=ja-JP"), env, "request-list", identity, "account-1",
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      items: [{ title: "Original title", translatedTitle: "翻訳タイトル",
        sourceTitleLocale: "en-US", translatedTitleLocale: "ja-JP", parseStatus: "error", parseError: "request_timeout" }],
    });
    expect(listBindings.mock.calls[0]).toContain("ja-JP");
  });

  it("excludes selected articles when the home collection requests it", async () => {
    const sql: string[] = [];
    const DB = {
      prepare(statementSql: string) {
        sql.push(statementSql);
        const statement = { bind() { return statement; }, first: async () => ({ total: 0 }),
          all: async () => ({ success: true, results: [] }), run: async () => ({ success: true, meta: { changes: 0 } }) };
        return statement;
      },
      async batch() { return []; },
    } as unknown as D1Database;
    const response = await routeClientApi(new Request("https://api.example/v1/articles?scope=all&excludeSelected=true"),
      { DB } as ClientApiEnv, "home", identity, "account-1");
    expect(response?.status).toBe(200);
    const articleStatements = sql.filter((statement) => statement.includes("FROM articles a"));
    expect(articleStatements.length).toBeGreaterThanOrEqual(2);
    expect(articleStatements.every((statement) => statement.includes("selected_feed.url = 'feedmind://selected/owner'"))).toBe(true);
  });

  it("creates a subscription and schedules a feed fetch", async () => {
    const send = vi.fn(async () => undefined);
    const env = {
      DB: database({ id: "feed-1" }),
      FEED_QUEUE: { send },
    } as unknown as ClientApiEnv;
    const response = await routeClientApi(new Request("https://api.example/v1/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ URL: "https://Example.com/feed.xml#latest", Title: "示例", Category: "技术" }),
    }), env, "request-feed", identity, "account-1");
    expect(response?.status).toBe(202);
    await expect(response?.json()).resolves.toMatchObject({ feedId: "feed-1", status: "queued" });
    expect(send).toHaveBeenCalledWith(
      { feedId: "feed-1", requestId: "request-feed", reason: "subscription_created" },
      { contentType: "json" },
    );
  });

  it("queues bidirectional article state changes and supersedes stale outbox rows", async () => {
    const send = vi.fn(async () => undefined);
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const DB = {
      prepare(sql: string) {
        const captured = { sql, bindings: [] as unknown[] };
        statements.push(captured);
        const statement = {
          bind(...bindings: unknown[]) { captured.bindings = bindings; return statement; },
          async first() {
            if (sql.includes("FROM account_source_selections")) return { connectionId: "connection-1", revision: 1 };
            if (sql.includes("FROM source_connections") && sql.includes("connector_type AS type")) return { id: "connection-1", type: "google_reader" };
            if (sql.includes("SELECT a.id FROM articles")) return { id: "article-1" };
            if (sql.includes("article_state_operations")) return null;
            return null;
          },
          async all() {
            if (sql.includes("FROM source_items si JOIN source_connections")) {
              return { success: true, results: [{ sourceItemId: "source-item-1", connectionId: "connection-1" }] };
            }
            return { success: true, results: [] };
          },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch() { return []; },
    } as unknown as D1Database;
    const env = { DB, FEED_QUEUE: { send } } as unknown as ClientApiEnv;
    const response = await routeClientApi(new Request("https://api.example/v1/articles/article-1/state", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isRead: true, isStarred: false, progress: 0, operationId: "operation-1" }),
    }), env, "request-state", identity, "account-1");
    expect(response?.status).toBe(204);
    expect(statements.some((entry) => entry.sql.includes("last_error_code = 'superseded'"))).toBe(true);
    expect(statements.some((entry) => entry.sql.includes("INSERT INTO state_sync_outbox"))).toBe(true);
    expect(send).toHaveBeenCalledWith(
      { connectionId: "connection-1", requestId: "request-state", reason: "state_changed" },
      { contentType: "json" },
    );
  });

  it("reads protected R2 text in Unicode-safe bounded chunks", async () => {
    const env = {
      DB: database({
        id: "article-1",
        sourceTextKey: "articles/article-1/hash/source.txt",
        sourceHtmlKey: "articles/article-1/hash/source.html",
        contentHash: "hash",
      }),
      CONTENT: {
        get: vi.fn(async () => ({
          body: new ReadableStream(),
          size: 10,
          text: async () => "<p>甲🙂乙丙</p>",
        })),
      },
    } as unknown as ClientApiEnv;
    const response = await routeClientApi(
      new Request("https://api.example/v1/articles/article-1/content?format=text&cursor=1&limit=2"),
      env,
      "request-1",
      identity,
      "account-1",
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      data: { content: "🙂乙", cursor: 1, nextCursor: 3, totalCharacters: 4 },
      requestId: "request-1",
    });
  });

  it("does not expose an R2 object without article ownership", async () => {
    const env = { DB: database(null) } as unknown as ClientApiEnv;
    await expect(routeClientApi(
      new Request("https://api.example/v1/articles/not-owned/content"),
      env,
      "request-2",
      identity,
      "account-1",
    )).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("does not expose client-side reparse", async () => {
    const env = {} as ClientApiEnv;
    await expect(routeClientApi(
      new Request("https://api.example/v1/articles/article-1/reparse", { method: "POST" }),
      env,
      "request-3",
      identity,
      "account-1",
    )).resolves.toBeUndefined();
  });

  it("returns an owned translation status without exposing content keys", async () => {
    const env = { DB: database({
      id: "translation-1", articleId: "article-1", targetLocale: "zh-CN", articleType: "technical",
      status: "running", sourceHash: "hash", translatedTitle: "标题", retryCount: 0,
      workflowInstanceId: "workflow-1", createdAt: "2026-08-25T00:00:00.000Z",
      startedAt: "2026-08-25T00:00:01.000Z", completedAt: null,
    }) } as unknown as ClientApiEnv;
    const response = await routeClientApi(
      new Request("https://api.example/v1/translations/translation-1"), env, "request-status", identity, "account-1",
    );
    expect(response?.status).toBe(200);
    const payload = await response?.json() as { data: Record<string, unknown> };
    expect(payload.data).toMatchObject({ id: "translation-1", status: "running", retryCount: 0 });
    expect(payload.data).not.toHaveProperty("contentHtmlKey");
    expect(payload.data).not.toHaveProperty("resultKey");
  });

  it("returns all blocks from a current historical translation", async () => {
    const env = {
      DB: database({
        articleId: "article-1", status: "completed", contentHtmlKey: "translations/t1/content.html",
        resultKey: "translations/t1/result.json", sourceHash: "source-1", currentSourceHash: "source-1",
      }),
      CONTENT: { get: vi.fn(async () => ({
        body: new ReadableStream(), size: 100,
        text: async () => "<p>历史译文正文。</p><p>历史固定推广译文。</p>",
      })) },
    } as unknown as ClientApiEnv;
    const response = await routeClientApi(
      new Request("https://api.example/v1/translations/t1/content"), env, "request-translation-content", identity, "account-1",
    );
    expect(response?.status).toBe(200);
    const payload = await response?.json() as { data: { content: string } };
    expect(payload.data.content).toContain("历史译文正文");
    expect(payload.data.content).toContain("历史固定推广译文");
  });

  it("returns completed translation batches while a translation is still running", async () => {
    const get = vi.fn(async (key: string) => ({
      body: new ReadableStream(), size: 100,
      text: async () => JSON.stringify({ batch: key.endsWith("1.json") ? 1 : 0,
        blocks: key.endsWith("1.json") ? [["b2", "第二段"]] : [["b0", "第一段"], ["b1", "继续"]] }),
    }));
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = {
            bind() { return statement; },
            async first() {
              if (sql.includes("FROM translations t JOIN articles")) return {
                articleId: "article-1", status: "running", contentHtmlKey: null,
                resultKey: null, sourceHash: "source-1", currentSourceHash: "source-1",
              };
              return null;
            },
            async all() {
              if (sql.includes("FROM translation_batches")) return { success: true, results: [
                { batchIndex: 0, partialKey: "translations/t1/partial/0.json" },
                { batchIndex: 1, partialKey: "translations/t1/partial/1.json" },
              ] };
              return { success: true, results: [] };
            },
          };
          return statement;
        },
      },
      CONTENT: { get },
    } as unknown as ClientApiEnv;
    const response = await routeClientApi(
      new Request("https://api.example/v1/translations/t1/content"), env, "request-partial-translation", identity, "account-1",
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ data: {
      format: "partial_blocks", completedBatches: 2,
      partialBlocks: [["b0", "第一段"], ["b1", "继续"], ["b2", "第二段"]],
    } });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("hides historical translation blocks removed by a newer source extraction", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = {
            bind() { return statement; },
            async first() {
              if (sql.includes("FROM translations t JOIN articles")) return {
                articleId: "article-1", status: "completed", contentHtmlKey: "translations/t1/content.html",
                resultKey: null, sourceHash: "old-source", currentSourceHash: "new-source",
              };
              if (sql.includes("FROM article_source_block_alignments")) return {
                mappingJson: JSON.stringify([{ fromStableId: "n0", toStableId: "n0" }]),
                currentCoverage: 1, isAmbiguous: 0,
              };
              return null;
            },
            async all() {
              if (sql.includes("FROM article_content_blocks")) return { success: true, results: [{ stableId: "n0" }, { stableId: "n1" }] };
              return { success: true, results: [] };
            },
          };
          return statement;
        },
      },
      CONTENT: { get: vi.fn(async () => ({
        body: new ReadableStream(), size: 100,
        text: async () => "<p>仍属于正文的译文。</p><p>已被新正文边界裁掉的译文。</p>",
      })) },
    } as unknown as ClientApiEnv;
    const response = await routeClientApi(
      new Request("https://api.example/v1/translations/t1/content"), env, "request-aligned-translation", identity, "account-1",
    );
    expect(response?.status).toBe(200);
    const payload = await response?.json() as { data: { content: string } };
    expect(payload.data.content).toContain("仍属于正文");
    expect(payload.data.content).not.toContain("已被新正文边界裁掉");
  });

  it("rejects retrying a non-terminal translation", async () => {
    const translation = {
      id: "translation-1", articleId: "article-1", targetLocale: "zh-CN", articleType: "technical",
      status: "running", sourceHash: "hash", translatedTitle: "标题", retryCount: 0,
      workflowInstanceId: "workflow-1", createdAt: "2026-08-25T00:00:00.000Z",
      startedAt: "2026-08-25T00:00:01.000Z", completedAt: null,
    };
    const env = { DB: {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first() { return sql.includes("FROM idempotency_requests") ? null : translation; },
        };
        return statement;
      },
    } } as unknown as ClientApiEnv;
    await expect(routeClientApi(new Request("https://api.example/v1/translations/translation-1/retry", {
      method: "POST", headers: { "Idempotency-Key": "retry-1" },
    }), env, "request-retry", identity, "account-1")).rejects.toMatchObject({ status: 409, code: "translation_not_retryable" });
  });

  it("classifies first and selects the body prompt for that article type", async () => {
    const promptBindings = vi.fn();
    const create = vi.fn(async () => ({ id: "workflow-1" }));
    const env = {
      DB: {
        prepare(sql: string) {
          let bindings: unknown[] = [];
          const statement = {
            bind(...values: unknown[]) {
              bindings = values;
              if (sql.includes("FROM prompt_definitions")) promptBindings(...values);
              return statement;
            },
            async first() {
              if (sql.includes("FROM idempotency_requests")) return null;
              if (sql.includes("JOIN article_classifications")) return {
                sourceHash: "source-hash", articleType: "technical", translatedTitle: "译文标题",
                titleProfileVersionId: "fast-v1",
              };
              if (sql.includes("FROM prompt_definitions")) return {
                promptVersionId: "technical-prompt-v2", bodyProfileVersionId: "quality-v3",
              };
              if (sql.includes("FROM translations WHERE id")) return {
                id: bindings[0], articleId: "article-1", targetLocale: "zh-CN", articleType: "technical",
                status: "pending", sourceHash: "source-hash", translatedTitle: "译文标题", retryCount: 0,
                workflowInstanceId: "workflow-1", createdAt: "2026-08-25T00:00:00.000Z",
              };
              return null;
            },
            async all() { return { success: true, results: [] }; },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
          return statement;
        },
        async batch() { return []; },
      },
      BODY_TRANSLATION_WORKFLOW: { create },
    } as unknown as ClientApiEnv;
    const response = await routeClientApi(new Request("https://api.example/v1/articles/article-1/translations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "translate-technical" },
      body: JSON.stringify({ targetLocale: "zh-CN" }),
    }), env, "request-translation", identity, "account-1");
    expect(response?.status).toBe(202);
    expect(promptBindings).toHaveBeenCalledWith("technical", "zh-CN");
    expect(create).toHaveBeenCalledOnce();
  });

  it("returns image translations only for the article's current source hash", async () => {
    const statements: string[] = [];
    const DB = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind() { return statement; },
          async first() { return null; },
          async all() { return { success: true, results: [{
            articleId: "article-1", imageId: "image-1", imageUrl: "https://example.com/image.png",
            targetLocale: "zh-CN", referenceWidth: 640, referenceHeight: 480,
            segmentsJson: '[{"x":10,"y":20,"w":100,"h":30,"text":"译文","bg":"#ffffff","color":"#000000","fontSize":16}]',
            updatedAt: "2026-10-23T00:00:00.000Z",
          }] }; },
          async run() { return { success: true, meta: { changes: 0 } }; },
        };
        return statement;
      },
      async batch() { return []; },
    } as unknown as D1Database;
    const response = await routeClientApi(
      new Request("https://api.example/v1/articles/article-1/image-translations?targetLocale=zh-CN"),
      { DB } as ClientApiEnv, "image-translations", identity, "account-1",
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      items: [{ imageId: "image-1", referenceWidth: 640, segments: [{ text: "译文" }] }],
    });
    expect(statements.some((sql) => sql.includes("article.source_hash = translation.source_hash"))).toBe(true);
  });
});
