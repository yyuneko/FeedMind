import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import type { AccessIdentity } from "../../shared/src/auth";
import { routeAdminApi, type AdminApiEnv } from "../src/routes";

const identity: AccessIdentity = { subject: "admin", email: "admin@example.com" };
const metadataResponse = () => new Response(JSON.stringify({ data: {
  canonicalModel: "openai/gpt-4.1-mini", contextWindowTokens: 1048576, fetchedAt: "2026-08-29T00:00:00.000Z",
} }), { headers: { "Content-Type": "application/json" } });

describe("Admin API boundary", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("does not accept a client-style bearer credential", async () => {
    const env = {
      ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      ACCESS_AUDIENCE: "admin-audience",
      ALLOWED_ORIGIN: "https://admin.feedmind.cc",
    } as Env;
    const response = await worker.fetch(new Request("https://admin-api.example/v1/session", {
      headers: { Authorization: "Bearer not-an-admin-assertion" },
    }), env);
    expect(response.status).toBe(401);
  });

  it("accepts the public /admin/v1 prefix and filters prompt changes", async () => {
    const bind = vi.fn();
    const all = vi.fn(async () => ({ success: true, results: [] }));
    const statement = { bind: (...args: unknown[]) => { bind(...args); return statement; }, all };
    const env = { DB: { prepare: () => statement } } as unknown as AdminApiEnv;
    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/prompts/prompt-1/changes"), env, "request-1", identity,
    );
    expect(response?.status).toBe(200);
    expect(bind).toHaveBeenCalledWith("prompt-1");
  });

  it("does not expose the removed global audit-log endpoint", async () => {
    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/audit-logs"), {} as AdminApiEnv, "request-no-audit", identity,
    );
    expect(response).toBeUndefined();
  });

  it("does not expose the virtual selected-articles feed as a subscription", async () => {
    let capturedSql = "";
    const bind = vi.fn();
    const env = {
      DB: {
        prepare(sql: string) {
          capturedSql = sql;
          const statement = {
            bind(...args: unknown[]) { bind(...args); return statement; },
            async all() { return { success: true, results: [] }; },
          };
          return statement;
        },
      },
    } as unknown as AdminApiEnv;

    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/feeds"), env, "request-feeds", identity,
    );

    expect(response?.status).toBe(200);
    expect(capturedSql).toContain("f.url <> ?2");
    expect(bind).toHaveBeenCalledWith("owner", "feedmind://selected/owner", "", "", "", 51, 0);
  });

  it("creates a platform extraction rule without creating or fetching a subscription", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const send = vi.fn();
    const env = {
      DB: {
        prepare(sql: string) {
          const captured = { sql, args: [] as unknown[] };
          statements.push(captured);
          const statement = {
            bind(...args: unknown[]) { captured.args = args; return statement; },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
          return statement;
        },
      },
      FEED_QUEUE: { send },
    } as unknown as AdminApiEnv;

    const response = await routeAdminApi(new Request("https://admin.example/admin/v1/platform-extraction-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "知乎",
        rule: { hostname: "zhuanlan.zhihu.com", pathPrefixes: ["/p/"], rootSelector: ".Post-RichText" },
      }),
    }), env, "request-platform-rule", identity);

    expect(response?.status).toBe(201);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("INSERT INTO platform_extraction_rules");
    expect(statements[0].sql).not.toContain("INSERT INTO feeds");
    expect(statements[0].sql).not.toContain("INSERT INTO subscriptions");
    expect(send).not.toHaveBeenCalled();
  });

  it("forces new AI profiles to use the fixed OpenRouter provider and endpoint", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn(async () => []);
    const env = {
      DB: {
        prepare(sql: string) {
          const captured = { sql, args: [] as unknown[] };
          statements.push(captured);
          const statement = {
            bind(...args: unknown[]) { captured.args = args; return statement; },
            async first() { return { version: 0 }; },
          };
          return statement;
        },
        batch,
      },
      AI_SERVICE: { fetch: vi.fn(metadataResponse) },
    } as unknown as AdminApiEnv;

    const response = await routeAdminApi(new Request("https://admin.example/admin/v1/ai-profile-versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "fast", model: "openai/gpt-4.1-mini", parameters: { temperature: 0.1 },
        provider: "anthropic", endpoint: "https://attacker.example/v1", thinkingEnabled: true,
      }),
    }), env, "request-openrouter-profile", identity);

    expect(response?.status).toBe(201);
    const insert = statements.find((item) => item.sql.includes("INSERT INTO ai_profile_versions"));
    expect(insert?.args.slice(3, 10)).toEqual([
      "openrouter", "https://openrouter.ai/api/v1", "openai/gpt-4.1-mini", null, null, null, 0,
    ]);
    expect(batch).toHaveBeenCalledOnce();
  });

  it("updates an existing AI profile without creating a new version", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn(async () => []);
    const current = {
      id: "profile-1", profile: "fast", version: 3, status: "draft", provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini",
      maxOutputTokens: 1024, parametersJson: '{"temperature":0.1}',
    };
    const env = {
      DB: {
        prepare(sql: string) {
          const captured = { sql, args: [] as unknown[] };
          statements.push(captured);
          const statement = {
            bind(...args: unknown[]) { captured.args = args; return statement; },
            async first() { return current; },
          };
          return statement;
        },
        batch,
      },
      AI_SERVICE: { fetch: vi.fn(metadataResponse) },
    } as unknown as AdminApiEnv;

    const response = await routeAdminApi(new Request("https://admin.example/admin/v1/ai-profiles/profile-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.6-flash:batch", maxOutputTokens: 2048,
        parameters: { temperature: 0.2 },
      }),
    }), env, "request-update-profile", identity);

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ data: {
      id: "profile-1", profile: "fast", version: 3, status: "draft",
      model: "google/gemini-3.6-flash:batch",
    } });
    expect(statements.some((item) => item.sql.includes("UPDATE ai_profile_versions SET"))).toBe(true);
    expect(statements.some((item) => item.sql.includes("INSERT INTO ai_profile_versions"))).toBe(false);
    expect(batch).toHaveBeenCalledOnce();
  });

  it("tests an active AI profile before updating it", async () => {
    const batch = vi.fn(async () => []);
    const statement = {
      bind() { return statement; },
      async first() { return {
        id: "profile-active", profile: "quality", version: 2, status: "active", provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini",
        maxOutputTokens: null, parametersJson: "{}",
      }; },
    };
    const fetch = vi.fn()
      .mockImplementationOnce(metadataResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "AI upstream HTTP 401: invalid key" } }),
        { status: 502, headers: { "Content-Type": "application/json" } }));
    const env = {
      DB: { prepare: () => statement, batch },
      AI_SERVICE: { fetch },
    } as unknown as AdminApiEnv;

    await expect(routeAdminApi(new Request("https://admin.example/admin/v1/ai-profiles/profile-active", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-3.6-flash:batch", parameters: {} }),
    }), env, "request-update-active", identity)).rejects.toMatchObject({
      status: 422, code: "ai_profile_test_failed",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(batch).not.toHaveBeenCalled();
  });

  it("keeps parse-retry admin-only and rejects non-failed articles", async () => {
    const statement = {
      bind() { return this; },
      async first() { return { url: "https://example.com/article", parseStatus: "completed" }; },
    };
    const env = { DB: { prepare: () => statement } } as unknown as AdminApiEnv;
    await expect(routeAdminApi(
      new Request("https://admin.example/admin/v1/articles/article-1/parse-retry", { method: "POST" }),
      env, "request-2", identity,
    )).rejects.toMatchObject({ status: 409, code: "article_parse_not_failed" });
  });

  it("allows an admin to manually retry classification and title translation", async () => {
    const create = vi.fn(async () => ({ id: "classification-workflow-1" }));
    const batch = vi.fn(async () => []);
    const statement = {
      bind() { return this; },
      async first() { return { sourceHash: "source-hash", sourceTextHash: "source-text-hash", parseStatus: "completed" }; },
      async run() { return { success: true, meta: { changes: 1 } }; },
    };
    const env = {
      DB: { prepare: () => ({ ...statement }), batch },
      CLASSIFICATION_WORKFLOW: { create },
    } as unknown as AdminApiEnv;

    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/articles/article-1/reclassify", { method: "POST" }),
      env, "request-reclassify", identity,
    );

    expect(response?.status).toBe(202);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ articleId: "article-1", sourceHash: "source-hash", sourceTextHash: "source-text-hash", requestId: "request-reclassify" }),
    }));
    expect(batch).not.toHaveBeenCalled();
  });

  it("lists feed parsing progress through the admin prefix", async () => {
    const bind = vi.fn();
    const queries: string[] = [];
    const statement = {
      bind(...args: unknown[]) { bind(...args); return this; },
      async all() { return { success: true, results: [{
        id: "article-1", parseStatus: "completed", preprocessingStatus: "completed", totalCount: 41,
        topicTagsJson: '[{"key":"finance","name":"金融","status":"active"}]',
      }] }; },
    };
    const env = { DB: { prepare: (sql: string) => { queries.push(sql); return statement; } } } as unknown as AdminApiEnv;
    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/article-parse-progress?feedId=feed-1&status=failed&limit=25"),
      env, "request-3", identity,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ items: [{
      id: "article-1", parseStatus: "completed", preprocessingStatus: "completed",
      topicTags: [{ key: "finance", name: "金融", status: "active" }],
    }], limit: 25, total: 41, totalPages: 2 });
    expect(bind).toHaveBeenCalledWith("owner", "feed-1", "failed", "", "", 26, 0);
    expect(queries[0]).toContain("AS preprocessingStatus");
    expect(queries[0]).toContain("article_preprocessing_runs");
    expect(queries[0]).toContain("article_preprocessing_tasks");
    expect(queries[0]).toContain("article_topic_tags");
    expect(queries[0]).toContain("topic_tags");
    expect(queries[0]).not.toContain("AS zhTitleStatus");
  });

  it("counts a feed article as successful only after classification and all title translations complete", async () => {
    const queries: string[] = [];
    const statement = {
      bind() { return this; },
      async all() { return { success: true, results: [] }; },
    };
    const env = { DB: { prepare: (sql: string) => { queries.push(sql); return statement; } } } as unknown as AdminApiEnv;

    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/feeds"), env, "request-feed-counts", identity,
    );

    expect(response?.status).toBe(200);
    expect(queries[0]).toContain("c.title_status = 'completed'");
    expect(queries[0]).toContain("zh.status = 'completed'");
    expect(queries[0]).toContain("en.status = 'completed'");
    expect(queries[0]).toContain("ja.status = 'completed'");
    expect(queries[0]).toContain("c.id IS NULL OR c.title_status <> 'completed'");
  });

  it("uses the stable operational smart order for feeds by default", async () => {
    const queries: string[] = [];
    const statement = {
      bind() { return this; },
      async all() { return { success: true, results: [] }; },
    };
    const env = { DB: { prepare: (sql: string) => { queries.push(sql); return statement; } } } as unknown as AdminApiEnv;

    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/feeds"), env, "request-smart-sort", identity,
    );

    expect(response?.status).toBe(200);
    expect(queries[0]).toContain("CASE b.fetchStatus WHEN 'failed' THEN 0 WHEN 'running' THEN 1");
    expect(queries[0]).toContain("WHEN 'pending' THEN 2 WHEN 'succeeded' THEN 3 ELSE 4 END ASC");
    expect(queries[0]).toContain("CASE WHEN b.fetchStatus = 'failed' THEN b.failureCount END DESC");
    expect(queries[0]).toContain("CASE WHEN b.fetchStatus = 'failed'");
    expect(queries[0]).toContain("CASE WHEN b.fetchStatus IN ('running', 'pending') THEN b.updatedAt END ASC");
    expect(queries[0]).toContain("CASE WHEN b.fetchStatus = 'succeeded'");
    expect(queries[0]).toContain("b.title COLLATE NOCASE ASC, b.id ASC");
  });

  it("supports recent feed ordering with filters and pagination", async () => {
    const queries: string[] = [];
    const bind = vi.fn();
    const statement = {
      bind(...args: unknown[]) { bind(...args); return this; },
      async all() { return { success: true, results: [] }; },
    };
    const env = { DB: { prepare: (sql: string) => { queries.push(sql); return statement; } } } as unknown as AdminApiEnv;

    const response = await routeAdminApi(new Request(
      "https://admin.example/admin/v1/feeds?sort=recent&query=tech&status=failed&limit=25&offset=50",
    ), env, "request-recent-sort", identity);

    expect(response?.status).toBe(200);
    expect(queries[0]).toContain("ORDER BY COALESCE(b.lastFetchedAt, b.updatedAt, b.createdAt) DESC");
    expect(queries[0]).toContain("b.title COLLATE NOCASE ASC, b.id ASC");
    expect(queries[0]).not.toContain("CASE b.fetchStatus WHEN 'failed'");
    expect(bind).toHaveBeenCalledWith(
      "owner", "feedmind://selected/owner", "tech", "tech", "failed", 26, 50,
    );
  });

  it("rejects an invalid feed sort before querying the database", async () => {
    const prepare = vi.fn();
    const env = { DB: { prepare } } as unknown as AdminApiEnv;

    await expect(routeAdminApi(
      new Request("https://admin.example/admin/v1/feeds?sort=oldest"), env, "request-invalid-sort", identity,
    )).rejects.toMatchObject({ status: 422, code: "validation_failed", message: "sort is invalid" });

    expect(prepare).not.toHaveBeenCalled();
  });

  it("saves a feed extraction rule as a draft version without activating it", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn(async () => []);
    const env = { DB: {
      prepare(sql: string) {
        const captured = { sql, args: [] as unknown[] }; statements.push(captured);
        const statement = {
          bind(...args: unknown[]) { captured.args = args; return statement; },
          async first() {
            if (sql.includes("FROM feeds WHERE")) return { id: "feed-1", title: "Feed", url: "https://example.test/feed" };
            if (sql.includes("FROM feed_extraction_rules WHERE feed_id")) return null;
            return null;
          },
        };
        return statement;
      },
      batch,
    } } as unknown as AdminApiEnv;
    const response = await routeAdminApi(new Request("https://admin.example/admin/v1/feeds/feed-1/extraction-rule/draft", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rule: { rootSelector: "article", endBefore: { selector: "h2", textEquals: "Author" } } }),
    }), env, "request-rule-draft", identity);
    expect(response?.status).toBe(201);
    expect(statements.find((item) => item.sql.includes("INSERT INTO feed_extraction_rule_versions"))?.args[3]).toContain('"rootSelector":"article"');
    expect(statements.some((item) => item.sql.includes("status = 'active'"))).toBe(false);
    expect(batch).toHaveBeenCalledOnce();
  });

  it("previews the saved draft against the active behavior without writing or invoking AI", async () => {
    const run = vi.fn();
    const batch = vi.fn();
    const env = { DB: {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first() {
            if (sql.includes("FROM feeds WHERE")) return { id: "feed-1", title: "Feed", url: "https://example.test/feed" };
            if (sql.includes("FROM articles") && sql.includes("canonical_url")) return { id: "article-1", url: "https://example.test/post" };
            if (sql.includes("v.status = 'draft'")) return { id: "draft-1", ruleId: "rule-1", version: 1, status: "draft",
              ruleJson: JSON.stringify({ rootSelector: "main", endBefore: { selector: "h2", textEquals: "Author" } }),
              configHash: "config-hash", changeNote: null, createdByEmail: identity.email, createdAt: new Date().toISOString() };
            if (sql.includes("v.status = 'active'")) return null;
            return null;
          },
          run,
        };
        return statement;
      }, batch,
    }, AI_SERVICE: { fetch: vi.fn() } } as unknown as AdminApiEnv;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `<body><main><p>${"Body content. ".repeat(80)}</p><h2>Author</h2><p>Profile</p></main></body>`,
      { headers: { "Content-Type": "text/html" } },
    )));
    const response = await routeAdminApi(new Request("https://admin.example/admin/v1/feeds/feed-1/extraction-rule/preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ articleId: "article-1" }),
    }), env, "request-rule-preview", identity);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ data: { candidate: { strategy: "site_rule" } } });
    expect(run).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(env.AI_SERVICE.fetch).not.toHaveBeenCalled();
  });

  it("publishes a draft without preview samples or confirmations", async () => {
    const batch = vi.fn();
    const env = { DB: {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first() {
            if (sql.includes("FROM feeds WHERE")) return { id: "feed-1", title: "Feed", url: "https://example.test/feed" };
            if (sql.includes("v.status = 'draft'")) return { id: "draft-1", ruleId: "rule-1", version: 1, status: "draft",
              ruleJson: '{"rootSelector":"article"}', configHash: "config-hash", changeNote: null,
              createdByEmail: identity.email, createdAt: new Date().toISOString() };
            if (sql.includes("active_version_id AS activeVersionId")) return { activeVersionId: null };
            return null;
          },
          async all() {
            return { success: true, results: [] };
          },
        };
        return statement;
      }, batch,
    } } as unknown as AdminApiEnv;
    const response = await routeAdminApi(new Request("https://admin.example/admin/v1/feeds/feed-1/extraction-rule/publish", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }), env, "request-rule-publish", identity);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ data: { activeVersionId: "draft-1", required: 0,
      confirmed: 0, selectedArticleIds: [] } });
    expect(batch).toHaveBeenCalledOnce();
  });

  it("includes the prompt and model snapshots used by translation tasks", async () => {
    const statement = {
      async all() {
        return {
          success: true,
          results: [{
            id: "translation-1", promptVersionId: "prompt-v3", promptVersion: 3, promptContent: "Translate: {{content}}",
            bodyProfileVersionId: "quality-v2", bodyProfile: "quality", bodyProfileVersion: 2,
            bodyProvider: "openai", bodyProtocol: "chat_completions", bodyEndpoint: "https://api.openai.com/v1",
            bodyModel: "gpt-test", bodyRegion: null, bodyWorkspaceId: null, bodyMaxOutputTokens: 4096,
            bodyThinkingEnabled: 1, bodyParametersJson: '{"temperature":0.2}',
            titleProfileVersionId: "fast-v1", titleProfile: "fast", titleProfileVersion: 1,
            titleProvider: "deepseek", titleProtocol: "chat_completions", titleEndpoint: "https://api.deepseek.com",
            titleModel: "deepseek-test", titleRegion: null, titleWorkspaceId: null, titleMaxOutputTokens: 512,
            titleThinkingEnabled: 0, titleParametersJson: "{}",
          }],
        };
      },
    };
    const env = { DB: { prepare: () => statement } } as unknown as AdminApiEnv;
    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/translations"), env, "request-translations", identity,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      items: [{
        id: "translation-1",
        prompt: { id: "prompt-v3", version: 3, content: "Translate: {{content}}" },
        bodyModelConfig: {
          id: "quality-v2", profile: "quality", version: 2, model: "gpt-test",
          thinkingEnabled: true, parameters: { temperature: 0.2 },
        },
        titleModelConfig: {
          id: "fast-v1", profile: "fast", version: 1, model: "deepseek-test",
          thinkingEnabled: false, parameters: {},
        },
      }],
    });
  });

  it("loads saved AI failure responses only when translation details are requested", async () => {
    const get = vi.fn(async () => ({ text: async () => '{"responseStatus":200,"responseBody":"invalid json"}' }));
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = {
            bind() { return statement; },
            async first() { return sql.includes("SELECT t.*") ? { id: "translation-1", articleTitle: "Article" } : null; },
            async all() {
              if (sql.includes("FROM translation_diagnostics")) return { success: true, results: [{
                id: "diagnostic-1", attemptId: "attempt-1", batchIndex: 0, failureStage: "response_parse",
                providerResponseKey: "translations/translation-1/diagnostics/attempt-1/diagnostic-1.json",
                errorCode: "response_parse_failed", errorMessage: "Translation response is not valid JSON",
                createdAt: "2026-08-25T00:00:00.000Z",
              }] };
              return { success: true, results: [] };
            },
          };
          return statement;
        },
      },
      CONTENT: { get },
    } as unknown as AdminApiEnv;
    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/translations/translation-1"), env, "request-detail", identity,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ data: { diagnostics: [{
      id: "diagnostic-1",
      providerResponse: '{"responseStatus":200,"responseBody":"invalid json"}',
    }] } });
    expect(get).toHaveBeenCalledWith("translations/translation-1/diagnostics/attempt-1/diagnostic-1.json");
  });

  it("queues an admin feed refresh", async () => {
    const send = vi.fn(async () => undefined);
    const statement = {
      bind() { return this; },
      async first() { return { fetchStatus: "failed" }; },
      async run() { return { success: true, meta: { changes: 1 } }; },
    };
    const env = {
      DB: { prepare: () => ({ ...statement }), batch: vi.fn(async () => []) },
      FEED_QUEUE: { send },
    } as unknown as AdminApiEnv;
    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/feeds/feed-1/refresh", { method: "POST" }),
      env, "request-4", identity,
    );
    expect(response?.status).toBe(202);
    expect(send).toHaveBeenCalledWith(
      { feedId: "feed-1", requestId: "request-4", reason: "admin_refresh" },
      { contentType: "json" },
    );
  });

  it("queues an admin source connection sync", async () => {
    const send = vi.fn(async () => undefined);
    const batch = vi.fn(async () => []);
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = {
            bind() { return statement; },
            async first() {
              if (sql.includes("SELECT fetch_status AS fetchStatus")) return null;
              if (sql.includes("FROM sources s JOIN source_connections")) {
                return { id: "source-1", connectionId: "connection-1", status: "ok" };
              }
              return null;
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
          return statement;
        },
        batch,
      },
      FEED_QUEUE: { send },
    } as unknown as AdminApiEnv;
    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/feeds/source-1/refresh", { method: "POST" }),
      env, "request-source-refresh", identity,
    );
    expect(response?.status).toBe(202);
    expect(batch).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      { connectionId: "connection-1", sourceId: "source-1", requestId: "request-source-refresh", reason: "admin_refresh" },
      { contentType: "json" },
    );
  });

  it("rejects deleting a feed that still has active subscribers", async () => {
    const statement = {
      bind() { return this; },
      async first() { return { id: "feed-1", url: "https://example.com/feed.xml", title: "Example", subscriberCount: 1 }; },
    };
    const env = { DB: { prepare: () => statement } } as unknown as AdminApiEnv;
    await expect(routeAdminApi(
      new Request("https://admin.example/admin/v1/feeds/feed-1", { method: "DELETE" }),
      env, "request-5", identity,
    )).rejects.toMatchObject({ status: 409, code: "feed_has_subscribers" });
  });

  it("updates a direct RSS feed name and its subscription override", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn(async () => []);
    const env = {
      DB: {
        prepare(sql: string) {
          const captured = { sql, args: [] as unknown[] };
          statements.push(captured);
          const statement = {
            bind(...args: unknown[]) { captured.args = args; return statement; },
            async first() { return { id: "feed-1" }; },
          };
          return statement;
        },
        batch,
      },
    } as unknown as AdminApiEnv;

    const response = await routeAdminApi(new Request("https://admin.example/admin/v1/feeds/feed-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新的订阅源名称" }),
    }), env, "request-update-feed-name", identity);

    expect(response?.status).toBe(200);
    expect(batch).toHaveBeenCalledOnce();
    expect(statements.some((item) => item.sql.includes("UPDATE feeds SET title"))).toBe(true);
    expect(statements.some((item) => item.sql.includes("UPDATE subscriptions SET custom_title"))).toBe(true);
  });

  it("updates an external source name", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          const captured = { sql, args: [] as unknown[] };
          statements.push(captured);
          const statement = {
            bind(...args: unknown[]) { captured.args = args; return statement; },
            async first() { return null; },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
          return statement;
        },
      },
    } as unknown as AdminApiEnv;

    const response = await routeAdminApi(new Request("https://admin.example/admin/v1/feeds/source-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "外部订阅名称" }),
    }), env, "request-update-source-name", identity);

    expect(response?.status).toBe(200);
    expect(statements.at(-1)?.sql).toContain("UPDATE sources SET title");
  });

  it("deletes a feed without active subscribers", async () => {
    const batch = vi.fn(async () => []);
    const statement = {
      bind() { return this; },
      async first() { return { id: "feed-1", url: "https://example.com/feed.xml", title: "Example", subscriberCount: 0 }; },
    };
    const env = { DB: { prepare: () => ({ ...statement }), batch } } as unknown as AdminApiEnv;
    const response = await routeAdminApi(
      new Request("https://admin.example/admin/v1/feeds/feed-1", { method: "DELETE" }),
      env, "request-6", identity,
    );
    expect(response?.status).toBe(204);
    expect(batch).toHaveBeenCalledOnce();
  });
});
