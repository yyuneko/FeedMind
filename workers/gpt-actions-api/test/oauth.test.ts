import { describe, expect, it } from "vitest";
import type { D1Database } from "../../shared/src/cloudflare";
import { oauthIdentity, oauthRevoke, oauthToken, type GptOAuthEnv } from "../src/oauth";

function env(sqlLog: string[]): GptOAuthEnv {
  return {
    GPT_OAUTH_CLIENT_ID: "feedmind-chatgpt-action",
    GPT_OAUTH_CLIENT_SECRET: "client-secret",
    DB: {
      prepare(sql: string) {
        sqlLog.push(sql);
        const statement = {
          bind() { return statement; },
          async first() {
            if (sql.includes("gpt_oauth_authorization_codes")) return {
              id: "code-1", ownerId: "account-1", clientId: "feedmind-chatgpt-action",
              redirectUri: "https://chatgpt.com/aip/g-test/oauth/callback",
              scope: "feedmind.read feedmind.write offline_access", codeChallenge: null,
              expiresAt: new Date(Date.now() + 60_000).toISOString(), consumedAt: null,
            };
            if (sql.includes("refresh_token_hash = ?1")) return {
              id: "session-1", ownerId: "account-1", clientId: "feedmind-chatgpt-action",
              scope: "feedmind.read feedmind.write offline_access",
              refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
            if (sql.includes("access_token_hash = ?1")) return {
              id: "session-1", ownerId: "account-1", scope: "feedmind.read feedmind.write",
            };
            return null;
          },
          async run() { return { success: true, meta: { changes: 1 } }; },
          async all() { return { success: true, results: [] }; },
        };
        return statement;
      },
      async batch() { return []; },
    } as D1Database,
  };
}

describe("GPT Actions OAuth endpoints", () => {
  it("exchanges a one-time authorization code for user tokens", async () => {
    const sql: string[] = [];
    const response = await oauthToken(new Request("https://actions.example/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: "one-time-code",
        redirect_uri: "https://chatgpt.com/aip/g-test/oauth/callback",
        client_id: "feedmind-chatgpt-action", client_secret: "client-secret",
      }),
    }), env(sql));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      token_type: "Bearer", expires_in: 3600, scope: "feedmind.read feedmind.write offline_access",
    });
    expect(sql.some((value) => value.includes("INSERT INTO gpt_oauth_sessions"))).toBe(true);
    expect(sql.some((value) => value.includes("consumed_at IS NULL"))).toBe(true);
  });

  it("rejects an invalid OAuth client", async () => {
    const response = await oauthToken(new Request("https://actions.example/oauth/token", {
      method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: "wrong", client_secret: "wrong" }),
    }), env([]));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
  });

  it("rotates refresh tokens and issues a new access token", async () => {
    const sql: string[] = [];
    const response = await oauthToken(new Request("https://actions.example/oauth/token", {
      method: "POST", body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: "old-refresh-token",
        client_id: "feedmind-chatgpt-action", client_secret: "client-secret",
      }),
    }), env(sql));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(sql.some((value) => value.includes("refresh_token_hash = ?4"))).toBe(true);
  });

  it("resolves a Bearer access token to its FeedMind account", async () => {
    const identity = await oauthIdentity(new Request("https://actions.example/gpt-actions/v1/articles", {
      headers: { Authorization: "Bearer user-access-token" },
    }), env([]));
    expect(identity.ownerId).toBe("account-1");
    expect(identity.scopes).toEqual(new Set(["feedmind.read", "feedmind.write"]));
  });

  it("revokes either an access or refresh token without revealing whether it existed", async () => {
    const sql: string[] = [];
    const response = await oauthRevoke(new Request("https://actions.example/oauth/revoke", {
      method: "POST", body: new URLSearchParams({ token: "token", client_id: "feedmind-chatgpt-action", client_secret: "client-secret" }),
    }), env(sql));
    expect(response.status).toBe(200);
    expect(sql.some((value) => value.includes("revoked_at"))).toBe(true);
  });
});
