import { describe, expect, it, vi } from "vitest";
import type { R2Bucket } from "../../shared/src/cloudflare";
import {
  providerResponse,
  RetryableProviderNetworkError,
  type ProviderResponse,
} from "../src/provider-response-cache";

const response = (): ProviderResponse => ({
  text: '{"blocks":{}}',
  usage: { inputTokens: 10, outputTokens: 20, thinkingTokens: 0 },
  latencyMs: 123,
  finishReason: "stop",
  responseStatus: 200,
  responseBody: '{"data":{"text":"{\\"blocks\\":{}}"}}',
});

describe("provider response cache", () => {
  it("persists a response and reuses it without invoking the provider again", async () => {
    const objects = new Map<string, string>();
    const content = {
      async get(key: string) {
        const value = objects.get(key);
        return value == null ? null : { size: value.length, body: new ReadableStream(), text: async () => value };
      },
      async put(key: string, value: string) { objects.set(key, value); return { key }; },
      async delete() {},
    } as unknown as R2Bucket;
    const invoke = vi.fn(async () => response());
    const input = {
      translationId: "translation-1",
      batchIndex: 2,
      phase: "translation" as const,
      request: { prompt: "translate", blocks: ["b1"] },
    };

    expect(await providerResponse({ CONTENT: content }, input, invoke)).toEqual(response());
    expect(await providerResponse({ CONTENT: content }, input, invoke)).toEqual(response());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect([...objects.keys()][0]).toMatch(
      /^translations\/translation-1\/provider-responses\/batch-2\/translation-[a-f0-9]{64}\.json$/,
    );
  });

  it("does not reuse a response when the provider request changes", async () => {
    const objects = new Map<string, string>();
    const content = {
      async get(key: string) {
        const value = objects.get(key);
        return value == null ? null : { size: value.length, body: new ReadableStream(), text: async () => value };
      },
      async put(key: string, value: string) { objects.set(key, value); return { key }; },
      async delete() {},
    } as unknown as R2Bucket;
    const invoke = vi.fn(async () => response());
    const base = { translationId: "translation-1", batchIndex: 0, phase: "repair" as const };

    await providerResponse({ CONTENT: content }, { ...base, request: { prompt: "first" } }, invoke);
    await providerResponse({ CONTENT: content }, { ...base, request: { prompt: "changed" } }, invoke);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("marks cache read failures as retryable network failures without calling the provider", async () => {
    const content = {
      async get() { throw new Error("R2 unavailable"); },
      async put() { return { key: "unused" }; },
      async delete() {},
    } as unknown as R2Bucket;
    const invoke = vi.fn(async () => response());

    await expect(providerResponse({ CONTENT: content }, {
      translationId: "translation-1",
      batchIndex: 0,
      phase: "translation",
      request: { prompt: "translate" },
    }, invoke)).rejects.toBeInstanceOf(RetryableProviderNetworkError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("marks cache write failures as retryable network failures after capturing the response", async () => {
    const content = {
      async get() { return null; },
      async put() { throw new Error("R2 unavailable"); },
      async delete() {},
    } as unknown as R2Bucket;
    const invoke = vi.fn(async () => response());

    await expect(providerResponse({ CONTENT: content }, {
      translationId: "translation-1",
      batchIndex: 0,
      phase: "translation",
      request: { prompt: "translate" },
    }, invoke)).rejects.toBeInstanceOf(RetryableProviderNetworkError);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
