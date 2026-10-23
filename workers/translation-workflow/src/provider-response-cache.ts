import type { R2Bucket } from "../../shared/src/cloudflare";

export interface ProviderResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number; thinkingTokens: number };
  latencyMs: number;
  finishReason: string | null;
  responseStatus: number;
  responseBody: string;
}

export class RetryableProviderNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableProviderNetworkError";
  }
}

interface CacheEnv { CONTENT: R2Bucket }

interface ProviderResponseCacheInput {
  translationId: string;
  batchIndex: number;
  phase: "translation" | "repair";
  request: unknown;
}

interface ProviderResponseEnvelope {
  version: 1;
  requestHash: string;
  capturedAt: string;
  response: ProviderResponse;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validResponse(value: unknown): value is ProviderResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Partial<ProviderResponse>;
  const usage = response.usage;
  return typeof response.text === "string" && response.text.length > 0
    && typeof response.latencyMs === "number"
    && (response.finishReason === null || typeof response.finishReason === "string")
    && typeof response.responseStatus === "number" && typeof response.responseBody === "string"
    && !!usage && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number"
    && typeof usage.thinkingTokens === "number";
}

/** Persists a successful provider response before any local parsing or validation can fail. */
export async function providerResponse(
  env: CacheEnv,
  input: ProviderResponseCacheInput,
  invoke: () => Promise<ProviderResponse>,
): Promise<ProviderResponse> {
  const requestHash = await sha256(JSON.stringify(input.request));
  const key = `translations/${input.translationId}/provider-responses/batch-${input.batchIndex}/${input.phase}-${requestHash}.json`;
  let existing: Awaited<ReturnType<R2Bucket["get"]>>;
  try {
    existing = await env.CONTENT.get(key);
  } catch (error) {
    throw new RetryableProviderNetworkError("Failed to read the cached provider response", { cause: error });
  }
  if (existing) {
    try {
      const envelope = JSON.parse(await existing.text()) as Partial<ProviderResponseEnvelope>;
      if (envelope.version === 1 && envelope.requestHash === requestHash && validResponse(envelope.response)) {
        return envelope.response;
      }
    } catch { /* A corrupt cache entry is replaced by a fresh provider response. */ }
  }

  const response = await invoke();
  const envelope: ProviderResponseEnvelope = {
    version: 1,
    requestHash,
    capturedAt: new Date().toISOString(),
    response,
  };
  try {
    await env.CONTENT.put(key, JSON.stringify(envelope), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch (error) {
    throw new RetryableProviderNetworkError("Failed to persist the provider response", { cause: error });
  }
  return response;
}
