import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement } from "../../shared/src/cloudflare";
import { processArticle, processFeed, purgeExpiredTranslationErrorLogs, scheduleDueWork, type PipelineEnv } from "../src/pipeline";

interface RecordedStatement {
  sql: string;
  bindings: unknown[];
}

function fakeDatabase(firstFor: (sql: string) => unknown, allFor: (sql: string) => unknown[] = () => []) {
  const runs: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
  const prepared: string[] = [];
  const prepare = (sql: string): D1PreparedStatement & RecordedStatement => {
    prepared.push(sql);
    const statement: D1PreparedStatement & RecordedStatement = {
      sql,
      bindings: [],
      bind(...values: unknown[]) { statement.bindings = values; return statement; },
      async first<T>() { return (sql.includes("SELECT 1 AS allowed") ? { allowed: 1 } : firstFor(sql)) as T | null; },
      async all<T>() { return { success: true, results: allFor(sql) as T[] }; },
      async run() { runs.push({ sql, bindings: statement.bindings }); return { success: true, meta: { changes: 1 } }; },
    };
    return statement;
  };
  const DB: D1Database = {
    prepare,
    async batch(statements) {
      batches.push(statements.map((item) => {
        const statement = item as D1PreparedStatement & RecordedStatement;
        return { sql: statement.sql, bindings: statement.bindings };
      }));
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return { DB, runs, batches, prepared };
}

function baseEnv(DB: D1Database): PipelineEnv {
  return {
    DB,
    CONTENT: { get: vi.fn(), put: vi.fn(async () => ({})), delete: vi.fn(async () => undefined) },
    FEED_QUEUE: { send: vi.fn(async () => undefined) },
    ARTICLE_QUEUE: { send: vi.fn(async () => undefined) },
    FEED_INTERVAL_MINUTES: "15",
    FEED_FETCH_LEASE_MINUTES: "5",
    MAX_CRON_BATCH: "100",
    ARTICLE_PARSE_LEASE_MINUTES: "5",
    CLASSIFICATION_WORKFLOW: {
      create: vi.fn(async () => ({ id: "workflow", status: vi.fn(), restart: vi.fn(), terminate: vi.fn() })),
      get: vi.fn(),
    },
    BODY_TRANSLATION_WORKFLOW: {
      create: vi.fn(async () => ({ id: "translation-workflow", status: vi.fn(), restart: vi.fn(), terminate: vi.fn() })),
      get: vi.fn(),
    },
  };
}

describe("pipeline processors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("discovers new feed articles and enqueues parse work", async () => {
    const fake = fakeDatabase((sql) => {
      if (sql.includes("SELECT owner_id AS ownerId")) return { ownerId: "owner", url: "https://example.com/feed.xml", etag: "", lastModified: "" };
      if (sql.includes("SELECT id, parse_status")) return null;
      return null;
    });
    const env = baseEnv(fake.DB);
    const fetcher = vi.fn().mockResolvedValue(new Response(
      `<rss><channel><title>Feed</title><link>https://example.com</link><item><guid>1</guid><title>Post</title><link>https://example.com/post</link></item></channel></rss>`,
      { headers: { "Content-Type": "application/rss+xml" } },
    ));
    vi.stubGlobal("fetch", fetcher);
    await processFeed({ feedId: "feed-1", requestId: "request-1" }, env);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fake.batches).toHaveLength(1);
    expect(env.ARTICLE_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "request-1", reason: "feed_discovered" }),
      { contentType: "json" },
    );
  });

  it("uses feed validators and treats 304 as a successful unchanged load", async () => {
    const fake = fakeDatabase((sql) => sql.includes("SELECT owner_id AS ownerId")
      ? { ownerId: "owner", url: "https://example.com/feed.xml", etag: '"feed-v1"', lastModified: "Mon, 24 Aug 2026 10:00:00 GMT" }
      : null);
    const env = baseEnv(fake.DB);
    const fetcher = vi.fn().mockResolvedValue(new Response(null, {
      status: 304,
    }));
    vi.stubGlobal("fetch", fetcher);
    await processFeed({ feedId: "feed-1", requestId: "request-304" }, env);
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("If-None-Match")).toBe('"feed-v1"');
    expect(headers.get("If-Modified-Since")).toBe("Mon, 24 Aug 2026 10:00:00 GMT");
    expect(fake.runs.some((statement) => statement.sql.includes("fetch_status = 'succeeded'"))).toBe(true);
    expect(env.ARTICLE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("does not automatically recreate parse work for a failed article", async () => {
    const fake = fakeDatabase((sql) => {
      if (sql.includes("SELECT owner_id AS ownerId")) return { ownerId: "owner", url: "https://example.com/feed.xml", etag: "", lastModified: "" };
      if (sql.includes("SELECT id, parse_status")) return { id: "failed-article", parseStatus: "failed" };
      return null;
    });
    const env = baseEnv(fake.DB);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `<rss><channel><title>Feed</title><link>https://example.com</link><item><guid>failed-1</guid><title>Failed</title><link>https://example.com/failed</link></item></channel></rss>`,
      { headers: { "Content-Type": "application/rss+xml" } },
    )));

    await processFeed({ feedId: "feed-1", requestId: "request-failed" }, env);

    expect(env.ARTICLE_QUEUE.send).not.toHaveBeenCalled();
    expect(fake.prepared.some((sql) => sql.includes("INSERT OR IGNORE INTO article_parse_tasks"))).toBe(false);
  });

  it("extracts article content and writes immutable R2 objects", async () => {
    const fake = fakeDatabase((sql) => sql.includes("SELECT canonical_url")
      ? { url: "https://example.com/post", title: "https://example.com/post" }
      : null);
    const env = baseEnv(fake.DB);
    const prose = "Readable article content. ".repeat(60);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `<html><head><title>Article Title</title></head><body><article><p>${prose}</p><pre><code class="language-rust">fn main() {}</code></pre><img src="/cover.png"></article></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    )));
    await processArticle({ articleId: "article-1", requestId: "request-2" }, env);
    expect(fake.runs.find((statement) => statement.sql.includes("SET status = 'running'"))?.sql)
      .toContain("heartbeat_at = ?1");
    expect(env.CONTENT.put).toHaveBeenCalledTimes(2);
    expect(vi.mocked(env.CONTENT.put).mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/^articles\/article-1\/[a-f0-9]{64}\/source\.html$/),
      expect.stringMatching(/^articles\/article-1\/[a-f0-9]{64}\/source\.txt$/),
    ]);
    const textBytes = vi.mocked(env.CONTENT.put).mock.calls.find(([key]) => String(key).endsWith("source.txt"))?.[1] as Uint8Array;
    const plainText = new TextDecoder().decode(textBytes);
    expect(plainText).toContain("Readable article content");
    expect(plainText).toContain("fn main() {}");
    expect(plainText).not.toMatch(/<\/?(?:p|pre|code)\b/i);
    expect(plainText).toContain("\n\n");
    expect(env.CLASSIFICATION_WORKFLOW.create).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^class-preprocess-fulltext-v1-article-1-/),
      params: expect.objectContaining({ articleId: "article-1" }),
    }));
    const update = fake.batches.at(-1)?.find((statement) => statement.sql.includes("UPDATE articles SET"));
    expect(update?.bindings).toContain("Article Title");
    expect(update?.bindings).toContain("https://example.com/cover.png");
  });

  it("falls back to upstream connector HTML when the canonical page cannot be fetched", async () => {
    const fake = fakeDatabase((sql) => {
      if (sql.includes("SELECT canonical_url")) return { url: "feedmind://source-item/connection/item", title: "Upstream", feedId: null };
      if (sql.includes("upstream_content_key")) return { contentKey: "source-items/connection/item/content.html", finalUrl: "https://example.com/post" };
      return null;
    });
    const env = baseEnv(fake.DB);
    env.CONTENT.get = vi.fn(async () => ({ body: new ReadableStream(), size: 100,
      text: async () => `<html><body><article><p>${"Upstream full text. ".repeat(80)}</p></article></body></html>` }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));

    await processArticle({ articleId: "upstream-article", requestId: "request-upstream" }, env);

    expect(env.CONTENT.get).toHaveBeenCalledWith("source-items/connection/item/content.html");
    expect(env.CONTENT.put).toHaveBeenCalledWith(expect.stringContaining("articles/upstream-article/"), expect.any(Uint8Array), expect.anything());
    expect(fake.batches.flat().some((statement) => statement.sql.includes("parse_status = 'completed'"))).toBe(true);
  });

  it("reduces non-content markup when article HTML exceeds the normal four MiB limit", async () => {
    const fake = fakeDatabase((sql) => sql.includes("SELECT canonical_url")
      ? { url: "https://example.com/large-report", title: "Large report" }
      : null);
    const env = baseEnv(fake.DB);
    const prose = "Readable report content. ".repeat(80);
    const oversizedScript = "x".repeat((4 << 20) + 1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `<html><body><script type="application/json">${oversizedScript}</script><article><p>${prose}</p></article></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    )));

    await processArticle({ articleId: "large-article", requestId: "request-large" }, env);

    const htmlBytes = vi.mocked(env.CONTENT.put).mock.calls.find(([key]) => String(key).endsWith("source.html"))?.[1] as Uint8Array;
    const html = new TextDecoder().decode(htmlBytes);
    expect(html).toContain("Readable report content");
    expect(html).not.toContain(oversizedScript.slice(0, 100));
  });

  it("keeps the legacy article image and bare-link normalization behavior", async () => {
    const fake = fakeDatabase((sql) => sql.includes("SELECT canonical_url")
      ? { url: "https://example.com/post", title: "Post" }
      : null);
    const env = baseEnv(fake.DB);
    const prose = "Readable article content. ".repeat(60);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `<html><body><article><p>${prose}</p><center><div><p><img src="/editorial.jpg"><br>Credit</p></div></center><p>img://cdn.example.com/chart.png https://example.com/reference.</p></article></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    )));
    await processArticle({ articleId: "article-legacy", requestId: "request-legacy" }, env);
    const htmlBytes = vi.mocked(env.CONTENT.put).mock.calls.find(([key]) => String(key).endsWith("source.html"))?.[1] as Uint8Array;
    const html = new TextDecoder().decode(htmlBytes);
    expect(html).toContain('src="https://example.com/editorial.jpg"');
    expect(html).toContain('src="https://cdn.example.com/chart.png"');
    expect(html).toContain('href="https://example.com/reference"');
  });

  it("keeps the original canonical URL when a redirect target belongs to another article", async () => {
    const fake = fakeDatabase((sql) => sql.includes("SELECT canonical_url")
      ? { url: "https://example.com/redirect", title: "Redirected article" }
      : null);
    const env = baseEnv(fake.DB);
    const prose = "Readable redirected article content. ".repeat(60);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 301,
        headers: { Location: "https://example.com/existing-article" },
      }))
      .mockResolvedValueOnce(new Response(`<html><body><article><p>${prose}</p></article></body></html>`, {
        headers: { "Content-Type": "text/html" },
      })));

    await processArticle({ articleId: "redirected-article", requestId: "request-redirect" }, env);

    const update = fake.batches.flat().find((statement) => statement.sql.includes("canonical_url = CASE"));
    expect(update?.sql).toContain("existing.canonical_url = ?2");
    expect(update?.sql).toContain("existing.id <> articles.id");
    expect(update?.sql).toContain("THEN canonical_url ELSE ?2 END");
    expect(update?.bindings).toContain("https://example.com/existing-article");
  });

  it("uses only the active extraction rule for the article feed", async () => {
    const fake = fakeDatabase((sql) => {
      if (sql.includes("SELECT canonical_url")) return { url: "https://example.com/post", title: "Post", feedId: "feed-1" };
      if (sql.includes("FROM feed_extraction_rules")) return {
        id: "rule-version-2",
        ruleJson: JSON.stringify({ rootSelector: "main.content", endBefore: { selector: "h2", textEquals: "Author" } }),
      };
      return null;
    });
    const env = baseEnv(fake.DB);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `<html><body><main class="content"><p>${"Article body. ".repeat(70)}</p><h2>Author</h2><p>Profile card</p></main></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    )));

    await processArticle({ articleId: "article-rule", requestId: "request-rule" }, env);

    const htmlBytes = vi.mocked(env.CONTENT.put).mock.calls.find(([key]) => String(key).endsWith("source.html"))?.[1] as Uint8Array;
    const html = new TextDecoder().decode(htmlBytes);
    expect(html).toContain("Article body");
    expect(html).not.toContain("Profile card");
    const update = fake.batches.flat().find((statement) => statement.sql.includes("extraction_rule_version_id"));
    expect(update?.bindings).toContain("rule-version-2");
    expect(update?.bindings).toContain("site_rule");
  });

  it("reschedules only explicitly created pending preprocessing tasks", async () => {
    const sourceHash = "0123456789abcdef0123456789abcdef";
    const sourceTextHash = "fedcba9876543210fedcba9876543210";
    const fake = fakeDatabase(() => null, (sql) => sql.includes("FROM article_preprocessing_tasks t")
      ? [{ taskId: "task-1", id: "legacy-article", sourceHash, sourceTextHash, requestId: "request-1" }]
      : []);
    const env = baseEnv(fake.DB);

    const result = await scheduleDueWork(env);

    expect(result.classifications).toBe(1);
    expect(env.CLASSIFICATION_WORKFLOW.create).toHaveBeenCalledWith(expect.objectContaining({
      id: "class-preprocess-fulltext-v1-legacy-article-fedcba9876543210",
      params: expect.objectContaining({ articleId: "legacy-article", sourceHash, sourceTextHash, taskId: "task-1" }),
    }));
    const recoveryQuery = fake.prepared.find((sql) => sql.includes("FROM article_preprocessing_tasks t"));
    expect(recoveryQuery).toContain("t.status = 'pending'");
    expect(recoveryQuery).toContain("a.source_text_hash = t.source_text_hash");
  });

  it("recovers expired feed and article leases and repairs orphan running articles", async () => {
    const fake = fakeDatabase(() => null);
    const env = baseEnv(fake.DB);

    const result = await scheduleDueWork(env);

    expect(result.articles).toBe(0);
    expect(env.ARTICLE_QUEUE.send).not.toHaveBeenCalled();
    const recoveryBatch = fake.batches[0];
    expect(recoveryBatch).toHaveLength(5);
    expect(recoveryBatch[0]?.sql).toContain("feed_fetch_lease_expired");
    expect(recoveryBatch[0]?.sql).toContain("fetch_status = 'running'");
    expect(recoveryBatch[1]?.sql).toContain("status = 'failed'");
    expect(recoveryBatch[1]?.sql).toContain("attempt_count >= ?3");
    expect(recoveryBatch[2]?.sql).toContain("status = 'pending'");
    expect(recoveryBatch[2]?.sql).toContain("attempt_count < ?3");
    expect(recoveryBatch[3]?.sql).toContain("parse_status = 'pending'");
    expect(recoveryBatch[4]?.sql).toContain("parse_status = 'failed'");
    expect(recoveryBatch[4]?.sql).toContain("NOT EXISTS");
    expect(recoveryBatch[2]?.bindings[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("purges translation failure diagnostics older than two weeks from R2 and D1", async () => {
    const fake = fakeDatabase(() => null, (sql) => sql.includes("FROM translation_diagnostics")
      ? [{ id: "diagnostic-old", providerResponseKey: "translations/t1/diagnostics/a1/diagnostic-old.json" }]
      : []);
    const env = baseEnv(fake.DB);

    const purged = await purgeExpiredTranslationErrorLogs(env, 25);

    expect(purged).toBe(1);
    expect(env.CONTENT.delete).toHaveBeenCalledWith(["translations/t1/diagnostics/a1/diagnostic-old.json"]);
    const select = fake.prepared.find((sql) => sql.includes("FROM translation_diagnostics"));
    expect(select).toContain("created_at < ?1");
    expect(fake.runs.find((statement) => statement.sql.includes("DELETE FROM translation_diagnostics"))?.bindings)
      .toEqual(["diagnostic-old"]);
    expect(fake.runs.some((statement) => statement.sql.includes("UPDATE translation_attempts SET error_code = NULL"))).toBe(true);
    expect(fake.runs.some((statement) => statement.sql.includes("UPDATE translation_batches SET error_code = NULL"))).toBe(true);
  });
});
