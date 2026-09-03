import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { openapi } from "../src/openapi";

function env(): Env {
  return {
    GPT_OAUTH_CLIENT_ID: "feedmind-chatgpt-action",
    GPT_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    GPT_OAUTH_AUTHORIZE_URL: "https://app.example/oauth/authorize",
    GPT_DAILY_REQUEST_LIMIT: "1000",
    GPT_DAILY_WRITE_LIMIT: "50",
    GPT_DAILY_TRANSLATION_LIMIT: "10",
    GPT_TRANSLATION_CONCURRENCY: "2",
    GPT_RATE_LIMITER: { async limit() { return { success: true }; } },
    DB: { prepare(sql: string) {
      const statement = {
        bind() { return statement; },
        async first() {
          if (sql.includes("FROM gpt_oauth_sessions")) {
            return { id: "session-1", ownerId: "account-1", scope: "feedmind.read feedmind.write offline_access" };
          }
          if (sql.includes("FROM idempotency_requests")) return null;
          if (sql.includes("SELECT sort_order AS sortOrder FROM library_categories")) return { sortOrder: 0 };
          return { value: 1 };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    } },
  } as unknown as Env;
}

describe("GPT Actions API boundary", () => {
  it("rejects the former fixed API key", async () => {
    const oauthOnlyEnv = env();
    const original = oauthOnlyEnv.DB;
    oauthOnlyEnv.DB = {
      prepare(sql: string) {
        if (sql.includes("FROM gpt_oauth_sessions")) {
          const statement = {
            bind() { return statement; },
            async first() { return null; },
            async run() { return { success: true, meta: { changes: 0 } }; },
            async all() { return { success: true, results: [] }; },
          };
          return statement as any;
        }
        return original.prepare(sql);
      },
      async batch(statements) { return original.batch(statements); },
    };
    const response = await worker.fetch(new Request("https://actions.example/gpt-actions/v1/not-found", {
      headers: { Authorization: "Bearer action-secret" },
    }), oauthOnlyEnv);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_access_token" } });
  });

  it("rejects Access assertions without the independent API key", async () => {
    const response = await worker.fetch(new Request("https://actions.example/gpt-actions/v1/articles", {
      headers: { "Cf-Access-Jwt-Assertion": "header.payload.signature" },
    }), env());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_access_token" } });
  });

  it("publishes a GPT-safe OpenAPI document with unique operation IDs", async () => {
    const response = await worker.fetch(new Request("https://actions.example/openapi.json"), env());
    expect(response.status).toBe(200);
    const document = await response.json() as typeof openapi;
    expect(document.openapi).toBe("3.1.0");
    expect(document.components.securitySchemes).toHaveProperty("oauth2");
    const operations = Object.values(document.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId));
    expect(new Set(operations).size).toBe(operations.length);
    expect(Object.keys(document.paths).every((path) => path.startsWith("/gpt-actions/v1/"))).toBe(true);
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining([
      "/gpt-actions/v1/articles",
      "/gpt-actions/v1/subscriptions",
      "/gpt-actions/v1/library/categories",
      "/gpt-actions/v1/translations/{translationId}",
      "/gpt-actions/v1/translations/{translationId}/result",
      "/gpt-actions/v1/translations/{translationId}/retry",
    ]));
    expect(Object.keys(document.paths).every((path) => !/admin|reparse|reclassify|restart|cancel/.test(path))).toBe(true);
    const parameters = Object.values(document.paths).flatMap((path) =>
      Object.values(path).flatMap((operation) => operation.parameters ?? []));
    expect(parameters.length).toBeGreaterThan(0);
    expect(parameters.every((parameter) => "name" in parameter && typeof parameter.name === "string")).toBe(true);
    expect(parameters.every((parameter) => !("$ref" in parameter))).toBe(true);
    expect(parameters.every((parameter) => parameter.in !== "header")).toBe(true);
    const writes = Object.values(document.paths).flatMap((path) =>
      Object.entries(path).filter(([method]) => method === "post").map(([, operation]) => operation));
    expect(writes.every((operation) => operation["x-openai-isConsequential"] === false)).toBe(true);
  });

  it.each([
    ["/gpt-actions/v1/subscriptions", { url: "https://example.com/feed.xml" }],
    ["/gpt-actions/v1/articles", { url: "https://example.com/article" }],
    ["/gpt-actions/v1/library/categories", { name: "技术" }],
  ])("requires idempotencyKey in the body for the create action %s", async (path, body) => {
    const response = await worker.fetch(new Request(`https://actions.example${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer oauth-access-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), env());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "idempotency_key_required" } });
  });

  it("creates a category through the GPT Action route", async () => {
    const response = await worker.fetch(new Request("https://actions.example/gpt-actions/v1/library/categories", {
      method: "POST",
      headers: {
        Authorization: "Bearer oauth-access-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "技术", idempotencyKey: "create-category-1" }),
    }), env());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { name: "技术", sortOrder: 0 } });
  });

  it("redirects the public OAuth authorization endpoint to the signed-in app", async () => {
    const response = await worker.fetch(new Request("https://actions.example/oauth/authorize?client_id=x&state=s"), env());
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://app.example/oauth/authorize?client_id=x&state=s");
  });

  it("enforces OAuth write scope before dispatching an Action", async () => {
    const oauthEnv = env();
    const original = oauthEnv.DB;
    oauthEnv.DB = {
      prepare(sql: string) {
        if (sql.includes("FROM gpt_oauth_sessions")) {
          const statement = {
            bind() { return statement; },
            async first() { return { id: "session-1", ownerId: "account-1", scope: "feedmind.read" }; },
            async run() { return { success: true, meta: { changes: 1 } }; },
            async all() { return { success: true, results: [] }; },
          };
          return statement as any;
        }
        return original.prepare(sql);
      },
      async batch(statements) { return original.batch(statements); },
    };
    const response = await worker.fetch(new Request("https://actions.example/gpt-actions/v1/unknown", {
      method: "POST", headers: { Authorization: "Bearer oauth-access-token" },
    }), oauthEnv);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "insufficient_scope" } });
  });
});
