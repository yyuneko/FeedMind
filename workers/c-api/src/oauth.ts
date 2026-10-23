import type { D1Database } from "../../shared/src/cloudflare";
import { ApiError } from "../../shared/src/http";
import { allowedRedirectUris, normalizeScopes, randomOAuthToken, sha256Hex } from "../../shared/src/oauth";

export interface OAuthAuthorizationEnv {
  DB: D1Database;
  GPT_OAUTH_CLIENT_ID: string;
  GPT_OAUTH_REDIRECT_URIS: string;
  GPT_OAUTH_ISSUER?: string;
}

const CHATGPT_CONNECTOR_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

function redirectError(redirectUri: string, state: string, issuer: string, error: string, description: string): Response {
  const destination = new URL(redirectUri);
  destination.searchParams.set("error", error);
  destination.searchParams.set("error_description", description);
  destination.searchParams.set("iss", issuer);
  if (state) destination.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: destination.toString() } });
}

export async function authorizeGptAction(
  request: Request,
  env: OAuthAuthorizationEnv,
  ownerId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = (url.searchParams.get("state") ?? "").slice(0, 2048);
  const issuer = env.GPT_OAUTH_ISSUER?.trim() || "https://actions.feedmind.cc";
  if (!env.GPT_OAUTH_CLIENT_ID || clientId !== env.GPT_OAUTH_CLIENT_ID) {
    throw new ApiError(400, "invalid_client", "OAuth client is not registered");
  }
  const redirectUris = allowedRedirectUris(env.GPT_OAUTH_REDIRECT_URIS);
  redirectUris.add(CHATGPT_CONNECTOR_REDIRECT_URI);
  if (!redirectUris.has(redirectUri)) {
    throw new ApiError(400, "invalid_redirect_uri", "OAuth redirect URI is not registered");
  }
  if (url.searchParams.get("response_type") !== "code") {
    return redirectError(redirectUri, state, issuer, "unsupported_response_type", "Only authorization code is supported");
  }
  let scopes: string[];
  try { scopes = normalizeScopes(url.searchParams.get("scope")); }
  catch { return redirectError(redirectUri, state, issuer, "invalid_scope", "Requested OAuth scope is not allowed"); }
  const challenge = (url.searchParams.get("code_challenge") ?? "").trim();
  const challengeMethod = (url.searchParams.get("code_challenge_method") ?? "").trim();
  if (challenge && (challengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))) {
    return redirectError(redirectUri, state, issuer, "invalid_request", "PKCE must use a valid S256 code challenge");
  }
  if (!challenge && challengeMethod) {
    return redirectError(redirectUri, state, issuer, "invalid_request", "code_challenge is required with code_challenge_method");
  }
  const code = randomOAuthToken("fm_oauth_code_");
  const created = new Date();
  await env.DB.prepare("DELETE FROM gpt_oauth_authorization_codes WHERE expires_at < ?1")
    .bind(created.toISOString()).run();
  await env.DB.prepare(`INSERT INTO gpt_oauth_authorization_codes
    (id, code_hash, owner_id, client_id, redirect_uri, scope, code_challenge, code_challenge_method,
     expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(crypto.randomUUID(), await sha256Hex(code), ownerId, clientId, redirectUri, scopes.join(" "),
      challenge || null, challenge ? "S256" : null,
      new Date(created.getTime() + 5 * 60_000).toISOString(), created.toISOString()).run();
  const destination = new URL(redirectUri);
  destination.searchParams.set("code", code);
  if (state) destination.searchParams.set("state", state);
  destination.searchParams.set("iss", issuer);
  return new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: destination.toString() } });
}
