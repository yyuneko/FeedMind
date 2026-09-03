import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement } from "../../shared/src/cloudflare";
import { routeSources } from "../src/sources";

describe("source connection API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("encrypts credentials and never returns them", async () => {
    const runs: Array<{ sql: string; bindings: unknown[] }> = [];
    const prepare = (sql: string): D1PreparedStatement => {
      const state = { bindings: [] as unknown[] };
      return {
        bind(...bindings: unknown[]) { state.bindings = bindings; return this; },
        async first<T>() { return (sql.includes("account_identities") ? { accountId: "account-1" } : null) as T | null; },
        async all<T>() { return { success: true, results: [] as T[] }; },
        async run() { runs.push({ sql, bindings: state.bindings }); return { success: true, meta: { changes: 1 } }; },
      };
    };
    const DB: D1Database = { prepare, async batch() { return []; } };
    const send = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("SID=x\nAuth=token\n")));
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const response = await routeSources(new Request("https://api.example/v1/connections", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        type: "google_reader", name: "FreshRSS", baseUrl: "https://rss.example/api/greader.php",
        credentials: { username: "alice", password: "top-secret" }, syncPolicy: "bidirectional",
      }),
    }), { DB, FEED_QUEUE: { send }, SOURCE_CREDENTIALS_KEY: key }, "request-1", { subject: "subject", email: "alice@example.com" });
    const payload = JSON.stringify(await response?.json());
    expect(response?.status).toBe(201);
    expect(payload).not.toContain("top-secret");
    const insert = runs.find((run) => run.sql.includes("INSERT INTO source_connections"));
    expect(String(insert?.bindings[5])).toMatch(/^v1\./);
    expect(String(insert?.bindings[5])).not.toContain("top-secret");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ connectionId: expect.any(String) }), { contentType: "json" });
  });
});
