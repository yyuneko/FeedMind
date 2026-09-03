import { describe, expect, it, vi } from "vitest";
import { invokeAi } from "../src/adapter";
import { OPENROUTER_ENDPOINT } from "../src/config";
import type { AiProfileConfig } from "../src/types";

const config: AiProfileConfig = {
  id: "openrouter-1", profile: "fast", provider: "openrouter", endpoint: OPENROUTER_ENDPOINT,
  model: "openai/gpt-4.1-mini", maxOutputTokens: 1024, thinkingEnabled: false, parameters: { temperature: 0.1 },
};

describe("OpenRouter adapter", () => {
  it("sends an OpenAI-compatible request and normalizes a non-streaming response", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const result = await invokeAi(config, {
      profile: "fast", system: "Return JSON", messages: [{ role: "user", content: "hello" }], json: true,
    }, "secret", fetcher);

    expect(result).toMatchObject({
      text: "{\"ok\":true}", finishReason: "stop", provider: "openrouter",
      usage: { inputTokens: 12, outputTokens: 4, thinkingTokens: 0 },
    });
    expect(fetcher).toHaveBeenCalledWith(`${OPENROUTER_ENDPOINT}/chat/completions`, expect.objectContaining({
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    }));
    const body = JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      model: "openai/gpt-4.1-mini", stream: true, stream_options: { include_usage: true },
      max_tokens: 1024, temperature: 0.1, reasoning: { effort: "none" }, response_format: { type: "json_object" },
    });
  });

  it("sends strict JSON Schema output constraints", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
    }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const schema = {
      type: "object", additionalProperties: false,
      properties: { ok: { type: "boolean" } }, required: ["ok"],
    };
    await invokeAi(config, {
      profile: "fast", system: "Return JSON", messages: [{ role: "user", content: "hello" }], jsonSchema: schema,
    }, "secret", fetcher);
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body))).toMatchObject({
      reasoning: { effort: "none" },
      response_format: { type: "json_schema", json_schema: { name: "feedmind_response", strict: true, schema } },
    });
  });

  it("omits the output token limit when the profile leaves it empty", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
    }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    await invokeAi({ ...config, maxOutputTokens: null }, {
      profile: "fast", system: "system", messages: [{ role: "user", content: "question" }],
    }, "secret", fetcher);
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body))).not.toHaveProperty("max_tokens");
  });

  it("parses fragmented SSE content and reasoning usage without exposing reasoning text", async () => {
    const events = [
      { choices: [{ delta: { reasoning_content: "private thought" } }] },
      { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 5 } } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(events);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
        controller.close();
      },
    });
    const fetcher = vi.fn(async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
    const result = await invokeAi(config, {
      profile: "fast", system: "system", messages: [{ role: "user", content: "question" }],
    }, "secret", fetcher);
    expect(result.text).toBe("answer");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 8, thinkingTokens: 5 });
  });

  it("submits batch profile tests through the OpenRouter Batch API", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "batch-1", status: "validating" }), {
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    const result = await invokeAi({ ...config, model: "google/gemini-3.6-flash:batch" }, {
      profile: "fast", system: "system", messages: [{ role: "user", content: "question" }], json: true,
    }, "secret", fetcher, { batchSubmitOnly: true });

    expect(result).toMatchObject({ text: "Batch request accepted", finishReason: "submitted" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.mocked(fetcher).mock.calls[0][0]).toBe("https://openrouter.ai/api/beta/batches");
    const request = JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body));
    expect(request).toMatchObject({
      endpoint: "/v1/chat/completions",
      model: "google/gemini-3.6-flash",
      requests: [{ custom_id: "feedmind-request-1", body: {
        model: "google/gemini-3.6-flash", stream: false, response_format: { type: "json_object" },
      } }],
    });
  });

  it("polls and normalizes completed OpenRouter batch results", async () => {
    const responses = [
      { id: "batch-2", status: "validating" },
      { id: "batch-2", status: "in_progress" },
      {
        id: "batch-2", status: "completed", results: [{
          custom_id: "feedmind-request-1",
          response: { status_code: 200, body: {
            choices: [{ message: { content: "batch answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          } },
        }],
      },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    const result = await invokeAi({ ...config, model: "google/gemini-3.6-flash:batch" }, {
      profile: "fast", system: "system", messages: [{ role: "user", content: "question" }],
    }, "secret", fetcher, { batchPollIntervalMs: 0, batchMaxPolls: 3 });

    expect(result).toMatchObject({
      text: "batch answer", finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 3, thinkingTokens: 0 },
      model: "google/gemini-3.6-flash:batch",
    });
    expect(vi.mocked(fetcher).mock.calls.map((call) => call[0])).toEqual([
      "https://openrouter.ai/api/beta/batches",
      "https://openrouter.ai/api/beta/batches/batch-2",
      "https://openrouter.ai/api/beta/batches/batch-2",
    ]);
  });

  it("retries a temporarily missing newly-created OpenRouter batch", async () => {
    const responses = [
      new Response(JSON.stringify({ id: "batch-3", status: "validating" }), {
        headers: { "Content-Type": "application/json" },
      }),
      new Response(JSON.stringify({ error: { message: "Batch job batch-3 not found" } }), {
        status: 404, headers: { "Content-Type": "application/json" },
      }),
      new Response(JSON.stringify({
        id: "batch-3", status: "completed", results: [{
          custom_id: "feedmind-request-1",
          response: { status_code: 200, body: {
            choices: [{ message: { content: "batch answer" }, finish_reason: "stop" }],
          } },
        }],
      }), { headers: { "Content-Type": "application/json" } }),
    ];
    const fetcher = vi.fn(async () => responses.shift()!) as typeof fetch;

    const result = await invokeAi({ ...config, model: "mistralai/mistral-small-2603:batch" }, {
      profile: "fast", system: "system", messages: [{ role: "user", content: "question" }],
    }, "secret", fetcher, { batchPollIntervalMs: 0, batchMaxPolls: 3 });

    expect(result.text).toBe("batch answer");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("stops retrying when a newly-created OpenRouter batch remains missing", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? new Response(JSON.stringify({ id: "batch-4", status: "validating" }), {
        headers: { "Content-Type": "application/json" },
      })
      : new Response(JSON.stringify({ error: { message: "Batch job batch-4 not found" } }), {
        status: 404, headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    await expect(invokeAi({ ...config, model: "mistralai/mistral-small-2603:batch" }, {
      profile: "fast", system: "system", messages: [{ role: "user", content: "question" }],
    }, "secret", fetcher, { batchPollIntervalMs: 0, batchMaxPolls: 2 }))
      .rejects.toThrow("AI upstream HTTP 404: Batch job batch-4 not found");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("requires the OpenRouter API key", async () => {
    await expect(invokeAi(config, {
      profile: "fast", system: "system", messages: [{ role: "user", content: "question" }],
    }, "")).rejects.toThrow("OpenRouter API key is not configured");
  });
});
