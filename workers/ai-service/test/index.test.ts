import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

function database() {
  const row = {
    id: "openrouter-fast-1", profile: "fast", provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini",
    maxOutputTokens: null, thinkingEnabled: 0, parametersJson: "{}",
  };
  const statement = { bind() { return statement; }, async first() { return row; } };
  return { prepare: () => statement } as unknown as Env["DB"];
}

function invocation() {
  return new Request("https://ai-service.example/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile: "fast", system: "system", messages: [{ role: "user", content: "question" }],
    }),
  });
}

describe("AI service OpenRouter credentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses OPENROUTER_API_KEY for active profile invocations", async () => {
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer openrouter-secret" });
      return new Response(JSON.stringify({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await worker.fetch(invocation(), {
      DB: database(), OPENROUTER_API_KEY: "openrouter-secret",
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("fails safely when OPENROUTER_API_KEY is missing", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await worker.fetch(invocation(), { DB: database() });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { message: "OpenRouter API key is not configured" } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("loads the context window from OpenRouter model metadata", async () => {
    const upstream = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/model/openai/gpt-4.1-mini%3Afree");
      return new Response(JSON.stringify({ data: {
        canonical_slug: "openai/gpt-4.1-mini:free", context_length: 1048576,
      } }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(new Request("https://ai-service.example/model-metadata", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-4.1-mini:free" }),
    }), { DB: database(), OPENROUTER_API_KEY: "openrouter-secret" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: {
      canonicalModel: "openai/gpt-4.1-mini:free", contextWindowTokens: 1048576,
    } });
  });
});
