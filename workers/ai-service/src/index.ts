import type { D1Database } from "../../shared/src/cloudflare";
import { invokeAi } from "./adapter";
import { validateProfile } from "./config";
import type { AiInvokeInput, AiProfile, AiProfileConfig, OpenRouterModelMetadata } from "./types";

export interface Env {
  DB: D1Database;
  OPENROUTER_API_KEY?: string;
}

function error(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: { code: status === 500 ? "ai_service_error" : "invalid_request", message } }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function safeProviderMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  if (message === "OpenRouter API key is not configured") return message;
  return /^AI upstream HTTP \d{3}: [^\r\n]{1,500}$/.test(message)
    ? message
    : "Configured AI provider request failed";
}

function modelPath(model: string): string {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error("OpenRouter model must use a vendor/model identifier");
  return `${encodeURIComponent(model.slice(0, slash))}/${encodeURIComponent(model.slice(slash + 1))}`;
}

export async function fetchOpenRouterModelMetadata(
  model: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<OpenRouterModelMetadata> {
  if (!apiKey) throw new Error("OpenRouter API key is not configured");
  const response = await fetcher(`https://openrouter.ai/api/v1/model/${modelPath(model.trim())}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`AI upstream HTTP ${response.status}: OpenRouter model metadata request failed`);
  const payload = await response.json() as { data?: Record<string, unknown> };
  const contextWindowTokens = Number(payload.data?.context_length);
  const canonicalModel = typeof payload.data?.canonical_slug === "string" ? payload.data.canonical_slug.trim() : "";
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0 || !canonicalModel) {
    throw new Error("OpenRouter model metadata response is invalid");
  }
  return { model: model.trim(), canonicalModel, contextWindowTokens, fetchedAt: new Date().toISOString() };
}

function validInput(value: unknown): value is AiInvokeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (input.profile === "fast" || input.profile === "quality") &&
    typeof input.system === "string" && input.system.length > 0 && input.system.length <= 100_000 &&
    Array.isArray(input.messages) && input.messages.length > 0 && input.messages.length <= 100 &&
    input.messages.every((message) => message && typeof message === "object" &&
      ((message as Record<string, unknown>).role === "user" || (message as Record<string, unknown>).role === "assistant") &&
      typeof (message as Record<string, unknown>).content === "string" &&
      ((message as Record<string, unknown>).content as string).length <= 20_000_000) &&
    (input.json === undefined || typeof input.json === "boolean") &&
    (input.jsonSchema === undefined || (input.jsonSchema !== null && typeof input.jsonSchema === "object" &&
      !Array.isArray(input.jsonSchema) && JSON.stringify(input.jsonSchema).length <= 100_000)) &&
    !(input.json && input.jsonSchema);
}

async function profile(env: Env, name: AiProfile): Promise<AiProfileConfig | null> {
  const row = await env.DB.prepare(`SELECT id, profile, provider, endpoint, model,
    max_output_tokens AS maxOutputTokens, thinking_enabled AS thinkingEnabled, parameters_json AS parametersJson
    FROM ai_profile_versions WHERE profile = ?1 AND provider = 'openrouter' AND status = 'active' LIMIT 1`)
    .bind(name).first<Record<string, unknown>>();
  if (!row) return null;
  let parameters: Record<string, unknown>;
  try { parameters = JSON.parse(String(row.parametersJson ?? "{}")) as Record<string, unknown>; } catch { return null; }
  return {
    id: String(row.id),
    profile: row.profile as AiProfile,
    provider: row.provider as AiProfileConfig["provider"],
    endpoint: String(row.endpoint),
    model: String(row.model),
    maxOutputTokens: row.maxOutputTokens == null ? null : Number(row.maxOutputTokens),
    thinkingEnabled: row.thinkingEnabled === 1,
    parameters,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/model-metadata" && request.method === "POST") {
      let metadataBody: unknown;
      try { metadataBody = await request.json(); } catch { return error("Request body must be valid JSON"); }
      const model = metadataBody && typeof metadataBody === "object" && !Array.isArray(metadataBody)
        ? (metadataBody as Record<string, unknown>).model : undefined;
      if (typeof model !== "string" || !/^[^\s/]+\/[^\s]+$/.test(model) || model.length > 200) {
        return error("OpenRouter model must use a vendor/model identifier", 422);
      }
      try {
        return new Response(JSON.stringify({ data: await fetchOpenRouterModelMetadata(model, env.OPENROUTER_API_KEY ?? "") }), {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        });
      } catch (cause) {
        return error(safeProviderMessage(cause), 502);
      }
    }
    if ((url.pathname !== "/invoke" && url.pathname !== "/test" && url.pathname !== "/invoke-version") || request.method !== "POST") return error("Endpoint not found", 404);
    const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") return error("Content-Type must be application/json", 415);
    let body: unknown;
    try { body = await request.json(); } catch { return error("Request body must be valid JSON"); }
    const testBody = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const input = url.pathname === "/test" || url.pathname === "/invoke-version" ? testBody.input : body;
    if (!validInput(input)) return error("AI invocation payload is invalid", 422);
    let active: AiProfileConfig | null;
    if (url.pathname === "/test") {
      try { active = validateProfile(testBody.config as AiProfileConfig); } catch (cause) {
        return error(cause instanceof Error ? cause.message : "AI profile is invalid", 422);
      }
      if (active.profile !== input.profile) return error("AI test profile does not match the invocation", 422);
    } else if (url.pathname === "/invoke-version") {
      const versionId = typeof testBody.profileVersionId === "string" ? testBody.profileVersionId : "";
      const row = versionId ? await env.DB.prepare(`SELECT id, profile, provider, endpoint, model,
        max_output_tokens AS maxOutputTokens, thinking_enabled AS thinkingEnabled, parameters_json AS parametersJson
        FROM ai_profile_versions WHERE id = ?1`).bind(versionId).first<Record<string, unknown>>() : null;
      if (!row) return error("AI profile version not found", 404);
      try {
        active = validateProfile({
          id: String(row.id), profile: row.profile as AiProfile, provider: row.provider as AiProfileConfig["provider"],
          endpoint: String(row.endpoint), model: String(row.model),
          maxOutputTokens: row.maxOutputTokens == null ? null : Number(row.maxOutputTokens),
          thinkingEnabled: row.thinkingEnabled === 1,
          parameters: JSON.parse(String(row.parametersJson ?? "{}")),
        });
      } catch { return error("AI profile version is invalid", 422); }
      if (active.profile !== input.profile) return error("AI profile version does not match the invocation", 422);
    } else {
      active = await profile(env, input.profile);
    }
    if (!active) return error(`Active ${input.profile} AI profile is not configured`, 503);
    try {
      const result = await invokeAi(active, input, env.OPENROUTER_API_KEY ?? "", fetch, {
        batchSubmitOnly: url.pathname === "/test",
      });
      return new Response(JSON.stringify({ data: result }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    } catch (cause) {
      console.error({
        service: "feedmind-ai-service",
        event: "ai_invocation_failed",
        profile: input.profile,
        profileVersionId: active.id,
        provider: active.provider,
        model: active.model,
        error: cause instanceof Error ? cause.message.slice(0, 500) : "unknown error",
      });
      return error(safeProviderMessage(cause), 502);
    }
  },
};
