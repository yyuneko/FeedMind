import { describe, expect, it } from "vitest";
import type { D1Database, D1PreparedStatement } from "../../shared/src/cloudflare";
import worker, { type Env } from "../src/index";

function base64Url(bytes: Uint8Array): string {
  let binary = ""; bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function digest(key: string, value: string): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value))));
}

function database(secretHash: string, authenticated = false, observedSql: string[] = []): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    observedSql.push(sql);
    const statement: D1PreparedStatement = {
      bind() { return statement; },
      async first<T>() {
        if (sql.includes("request_count AS count")) return { count: 1 } as T;
        if (authenticated && sql.includes("credential.owner_id AS ownerId")) return {
          ownerId: "account-1", credentialId: "credential-1", sessionId: "session-1", loginName: "alice@example.com",
        } as T;
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM reader_api_credentials")) return { success: true,
          results: [{ id: "credential-1", ownerId: "account-1", secretHash }] as T[] };
        return { success: true, results: [] as T[] };
      },
      async run() { return { success: true, meta: { changes: 1 } }; },
    };
    return statement;
  };
  return { prepare, async batch() { return []; } };
}

describe("Google Reader public API", () => {
  it("rejects protected endpoints without a GoogleLogin session", async () => {
    const response = await worker.fetch(new Request("https://reader.example/reader/api/0/subscription/list"), {
      DB: database(""), CONTENT: { get: async () => null, put: async () => ({}), delete: async () => undefined },
      FEED_QUEUE: { send: async () => undefined }, READER_CREDENTIALS_KEY: "test-key",
    });
    expect(response.status).toBe(401);
  });

  it("issues a revocable ClientLogin token for an application password", async () => {
    const key = "test-reader-key"; const password = "fm_device_secret";
    const env: Env = { DB: database(await digest(key, password)),
      CONTENT: { get: async () => null, put: async () => ({}), delete: async () => undefined },
      FEED_QUEUE: { send: async () => undefined }, READER_CREDENTIALS_KEY: key };
    const response = await worker.fetch(new Request("https://reader.example/accounts/ClientLogin", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "127.0.0.1" },
      body: new URLSearchParams({ Email: "alice@example.com", Passwd: password }),
    }), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/^SID=.+\nLSID=.+\nAuth=.+\n$/);
  });

  it("keeps protocol reads pinned to the local direct RSS connection", async () => {
    const observedSql: string[] = [];
    const response = await worker.fetch(new Request("https://reader.example/reader/api/0/subscription/list", {
      headers: { Authorization: "GoogleLogin auth=session-secret" },
    }), {
      DB: database("", true, observedSql), CONTENT: { get: async () => null, put: async () => ({}), delete: async () => undefined },
      FEED_QUEUE: { send: async () => undefined }, READER_CREDENTIALS_KEY: "test-key",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ subscriptions: [] });
    expect(observedSql.some((sql) => sql.includes("connection.connector_type = 'direct_rss'"))).toBe(true);
    expect(observedSql.some((sql) => sql.includes("account_source_selections"))).toBe(false);
  });

  it("allows reads but blocks Reader writes in read-only migration mode", async () => {
    const migrationEnv: Env = {
      DB: database("", true), CONTENT: { get: async () => null, put: async () => ({}), delete: async () => undefined },
      FEED_QUEUE: { send: async () => undefined }, READER_CREDENTIALS_KEY: "test-key", MIGRATION_MODE: "read_only",
    };
    const headers = { Authorization: "GoogleLogin auth=session-secret" };
    expect((await worker.fetch(new Request("https://reader.example/reader/api/0/subscription/list", { headers }), migrationEnv)).status).toBe(200);
    const blocked = await worker.fetch(new Request("https://reader.example/reader/api/0/edit-tag", {
      method: "POST", headers, body: "i=item-1",
    }), migrationEnv);
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("Retry-After")).toBe("300");
  });
});
