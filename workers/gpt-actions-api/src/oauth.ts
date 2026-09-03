import { timingSafeEqual } from "../../shared/src/auth";
import type { D1Database } from "../../shared/src/cloudflare";
import { ApiError } from "../../shared/src/http";
import { normalizeScopes, oauthError, oauthJson, randomOAuthToken, sha256Hex } from "../../shared/src/oauth";

export interface GptOAuthEnv {
  DB: D1Database;
  GPT_OAUTH_CLIENT_ID: string;
  GPT_OAUTH_CLIENT_SECRET: string;
}

interface AuthorizationCode {
  id: string;
  ownerId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string | null;
  expiresAt: string;
  consumedAt: string | null;
}

interface OAuthSession {
  id: string;
  ownerId: string;
  clientId: string;
  scope: string;
  refreshExpiresAt: string | null;
}

export interface GptOAuthIdentity {
  ownerId: string;
  scopes: Set<string>;
  kind: "oauth";
}

function form(request: Request): Promise<URLSearchParams> {
  return request.text().then((body) => new URLSearchParams(body));
}

function basicCredentials(request: Request): { clientId: string; clientSecret: string } | null {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Basic ")) return null;
  try {
    const decoded = atob(authorization.slice(6).trim());
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch { return null; }
}

async function authenticateClient(request: Request, input: URLSearchParams, env: GptOAuthEnv): Promise<boolean> {
  const basic = basicCredentials(request);
  const clientId = basic?.clientId ?? input.get("client_id") ?? "";
  const clientSecret = basic?.clientSecret ?? input.get("client_secret") ?? "";
  return timingSafeEqual(clientId, env.GPT_OAUTH_CLIENT_ID)
    .then(async (idMatches) => idMatches && await timingSafeEqual(clientSecret, env.GPT_OAUTH_CLIENT_SECRET));
}

async function verifyPkce(code: AuthorizationCode, verifier: string): Promise<boolean> {
  if (!code.codeChallenge) return true;
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return timingSafeEqual(challenge, code.codeChallenge);
}

async function issueSession(env: GptOAuthEnv, code: AuthorizationCode): Promise<Response> {
  const accessToken = randomOAuthToken("fm_oauth_at_");
  const scopes = code.scope.split(/\s+/).filter(Boolean);
  const refreshToken = scopes.includes("offline_access") ? randomOAuthToken("fm_oauth_rt_") : null;
  const created = new Date();
  const accessExpires = new Date(created.getTime() + 60 * 60_000);
  const refreshExpires = refreshToken ? new Date(created.getTime() + 30 * 24 * 60 * 60_000) : null;
  await env.DB.prepare(`INSERT INTO gpt_oauth_sessions
    (id, owner_id, client_id, scope, access_token_hash, access_expires_at, refresh_token_hash,
     refresh_expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`)
    .bind(crypto.randomUUID(), code.ownerId, code.clientId, code.scope, await sha256Hex(accessToken),
      accessExpires.toISOString(), refreshToken ? await sha256Hex(refreshToken) : null,
      refreshExpires?.toISOString() ?? null, created.toISOString()).run();
  return oauthJson({
    access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: code.scope,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  });
}

async function exchangeAuthorizationCode(input: URLSearchParams, env: GptOAuthEnv): Promise<Response> {
  const rawCode = input.get("code") ?? "";
  const redirectUri = input.get("redirect_uri") ?? "";
  if (!rawCode || !redirectUri) return oauthError("invalid_request", "code and redirect_uri are required");
  const code = await env.DB.prepare(`SELECT id, owner_id AS ownerId, client_id AS clientId,
      redirect_uri AS redirectUri, scope, code_challenge AS codeChallenge, expires_at AS expiresAt,
      consumed_at AS consumedAt FROM gpt_oauth_authorization_codes WHERE code_hash = ?1`)
    .bind(await sha256Hex(rawCode)).first<AuthorizationCode>();
  if (!code || code.consumedAt || code.expiresAt <= new Date().toISOString()
      || code.clientId !== env.GPT_OAUTH_CLIENT_ID || code.redirectUri !== redirectUri
      || !await verifyPkce(code, input.get("code_verifier") ?? "")) {
    return oauthError("invalid_grant", "Authorization code is invalid, expired, or already used");
  }
  const consumed = await env.DB.prepare(`UPDATE gpt_oauth_authorization_codes SET consumed_at = ?1
    WHERE id = ?2 AND consumed_at IS NULL AND expires_at > ?1`).bind(new Date().toISOString(), code.id).run();
  if ((consumed.meta?.changes ?? 0) !== 1) return oauthError("invalid_grant", "Authorization code is invalid, expired, or already used");
  return issueSession(env, code);
}

async function exchangeRefreshToken(input: URLSearchParams, env: GptOAuthEnv): Promise<Response> {
  const rawRefresh = input.get("refresh_token") ?? "";
  if (!rawRefresh) return oauthError("invalid_request", "refresh_token is required");
  const session = await env.DB.prepare(`SELECT id, owner_id AS ownerId, client_id AS clientId, scope,
      refresh_expires_at AS refreshExpiresAt FROM gpt_oauth_sessions
      WHERE refresh_token_hash = ?1 AND revoked_at IS NULL`)
    .bind(await sha256Hex(rawRefresh)).first<OAuthSession>();
  const current = new Date();
  if (!session || session.clientId !== env.GPT_OAUTH_CLIENT_ID || !session.refreshExpiresAt
      || session.refreshExpiresAt <= current.toISOString()) {
    return oauthError("invalid_grant", "Refresh token is invalid, expired, or revoked");
  }
  let scopes: string[];
  try { scopes = normalizeScopes(input.get("scope") || session.scope); }
  catch { return oauthError("invalid_scope", "Requested OAuth scope is not allowed"); }
  const original = new Set(session.scope.split(/\s+/));
  if (scopes.some((scope) => !original.has(scope))) return oauthError("invalid_scope", "Requested scope exceeds the original grant");
  const accessToken = randomOAuthToken("fm_oauth_at_");
  const refreshToken = randomOAuthToken("fm_oauth_rt_");
  const accessExpires = new Date(current.getTime() + 60 * 60_000);
  const refreshExpires = new Date(current.getTime() + 30 * 24 * 60 * 60_000);
  const updated = await env.DB.prepare(`UPDATE gpt_oauth_sessions SET scope = ?1, access_token_hash = ?2,
      access_expires_at = ?3, refresh_token_hash = ?4, refresh_expires_at = ?5, updated_at = ?6
      WHERE id = ?7 AND refresh_token_hash = ?8 AND revoked_at IS NULL`)
    .bind(scopes.join(" "), await sha256Hex(accessToken), accessExpires.toISOString(), await sha256Hex(refreshToken),
      refreshExpires.toISOString(), current.toISOString(), session.id, await sha256Hex(rawRefresh)).run();
  if ((updated.meta?.changes ?? 0) !== 1) return oauthError("invalid_grant", "Refresh token is invalid, expired, or already rotated");
  return oauthJson({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer",
    expires_in: 3600, scope: scopes.join(" ") });
}

export async function oauthToken(request: Request, env: GptOAuthEnv): Promise<Response> {
  const input = await form(request);
  if (!await authenticateClient(request, input, env)) return oauthError("invalid_client", "OAuth client authentication failed", 401);
  const grantType = input.get("grant_type") ?? "";
  if (grantType === "authorization_code") return exchangeAuthorizationCode(input, env);
  if (grantType === "refresh_token") return exchangeRefreshToken(input, env);
  return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported");
}

export async function oauthRevoke(request: Request, env: GptOAuthEnv): Promise<Response> {
  const input = await form(request);
  if (!await authenticateClient(request, input, env)) return oauthError("invalid_client", "OAuth client authentication failed", 401);
  const token = input.get("token") ?? "";
  if (!token) return oauthError("invalid_request", "token is required");
  const hash = await sha256Hex(token);
  await env.DB.prepare(`UPDATE gpt_oauth_sessions SET revoked_at = ?1, updated_at = ?1
    WHERE client_id = ?2 AND revoked_at IS NULL AND (access_token_hash = ?3 OR refresh_token_hash = ?3)`)
    .bind(new Date().toISOString(), env.GPT_OAUTH_CLIENT_ID, hash).run();
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
}

export async function oauthIdentity(request: Request, env: GptOAuthEnv): Promise<GptOAuthIdentity> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) throw new ApiError(401, "invalid_access_token", "OAuth access token is missing");
  const timestamp = new Date().toISOString();
  const session = await env.DB.prepare(`SELECT id, owner_id AS ownerId, scope FROM gpt_oauth_sessions
    WHERE access_token_hash = ?1 AND client_id = ?2 AND revoked_at IS NULL AND access_expires_at > ?3`)
    .bind(await sha256Hex(token), env.GPT_OAUTH_CLIENT_ID, timestamp)
    .first<{ id: string; ownerId: string; scope: string }>();
  if (!session) throw new ApiError(401, "invalid_access_token", "OAuth access token is invalid, expired, or revoked");
  await env.DB.prepare("UPDATE gpt_oauth_sessions SET last_used_at = ?1, updated_at = ?1 WHERE id = ?2")
    .bind(timestamp, session.id).run();
  return { ownerId: session.ownerId, scopes: new Set(session.scope.split(/\s+/).filter(Boolean)), kind: "oauth" };
}
