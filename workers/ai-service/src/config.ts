import type { AiProfileConfig } from "./types";

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1";

const ALLOWED_PARAMETERS = new Set([
  "temperature", "top_p", "presence_penalty", "frequency_penalty", "seed", "stop",
]);

function trimEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function validateProfile(config: AiProfileConfig): AiProfileConfig {
  if (!(["fast", "quality"] as string[]).includes(config.profile)) throw new Error("AI profile is invalid");
  if (config.provider !== "openrouter") throw new Error("Only OpenRouter AI profiles are supported");
  if (!/^[^\s/]+\/[^\s]+$/.test(config.model.trim()) || config.model.length > 200) {
    throw new Error("OpenRouter model must use a vendor/model identifier");
  }
  if (config.maxOutputTokens !== null &&
      (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1)) {
    throw new Error("AI max output token setting is invalid");
  }
  if (typeof config.thinkingEnabled !== "boolean") throw new Error("AI thinking setting is invalid");
  if (trimEndpoint(config.endpoint) !== OPENROUTER_ENDPOINT) throw new Error("AI endpoint is not the OpenRouter endpoint");
  for (const key of Object.keys(config.parameters)) {
    if (!ALLOWED_PARAMETERS.has(key)) throw new Error(`AI parameter is not allowed: ${key}`);
  }
  return { ...config, endpoint: OPENROUTER_ENDPOINT, model: config.model.trim() };
}
