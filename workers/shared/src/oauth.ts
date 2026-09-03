import { ApiError } from "./http";

export const GPT_OAUTH_SCOPES = ["feedmind.read", "feedmind.write", "offline_access"] as const;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomOAuthToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}${encoded}`;
}

export function allowedRedirectUris(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

export function normalizeScopes(value: string | null | undefined, defaults = GPT_OAUTH_SCOPES): string[] {
  const requested = (value?.trim() ? value.trim().split(/\s+/) : [...defaults]);
  const unique = [...new Set(requested)];
  if (unique.length === 0 || unique.some((scope) => !GPT_OAUTH_SCOPES.includes(scope as typeof GPT_OAUTH_SCOPES[number]))) {
    throw new ApiError(400, "invalid_scope", "Requested OAuth scope is not allowed");
  }
  return unique;
}

export function oauthJson(payload: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Pragma", "no-cache");
  return new Response(JSON.stringify(payload), { status, headers });
}

export function oauthError(error: string, description: string, status = 400): Response {
  return oauthJson({ error, error_description: description }, status,
    status === 401 ? { "WWW-Authenticate": 'Basic realm="FeedMind OAuth"' } : undefined);
}
