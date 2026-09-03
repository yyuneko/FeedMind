import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

const env = {
  ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
  ACCESS_AUDIENCE: "client-audience",
  ALLOWED_ORIGIN: "https://app.feedmind.cc",
} as Env;

describe("C API boundary", () => {
  it("exposes a request-traced health endpoint", async () => {
    const response = await worker.fetch(new Request("https://api.example/health"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-FeedMind-Request-ID")).toBeTruthy();
  });

  it("requires a C Access assertion for business endpoints", async () => {
    const response = await worker.fetch(new Request("https://api.example/v1/session"), env);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "access_token_required" } });
  });

  it("does not treat a GPT bearer key as C authentication", async () => {
    const response = await worker.fetch(new Request("https://api.example/v1/session", {
      headers: { Authorization: "Bearer action-secret" },
    }), env);
    expect(response.status).toBe(401);
  });
});
