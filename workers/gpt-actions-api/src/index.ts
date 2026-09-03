import type { D1Database, Queue, R2Bucket, WorkflowBinding } from "../../shared/src/cloudflare";
import { ApiError, errorResponse, json, requestId } from "../../shared/src/http";
import {
  addArticle, addSubscription, getArticle, getArticleContent, getTranslation, getTranslationContent, listArticles, listTranslations,
  retryTranslation, startTranslation,
  type ClientApiEnv,
} from "../../c-api/src/routes";
import { createCategory } from "../../c-api/src/library";
import { openapi } from "./openapi";
import { REQUEST_OWNER, scopedDatabase } from "../../shared/src/scoped-db";
import { oauthError } from "../../shared/src/oauth";
import { oauthIdentity, oauthRevoke, oauthToken, type GptOAuthIdentity } from "./oauth";

interface RateLimit { limit(input: { key: string }): Promise<{ success: boolean }> }

export interface Env {
  DB: D1Database;
  CONTENT: R2Bucket;
  BODY_TRANSLATION_WORKFLOW: WorkflowBinding<{ translationId: string; attemptId: string; requestId: string }>;
  FEED_QUEUE: Queue<{ feedId: string; requestId: string; reason: "subscription_created" | "manual_refresh" }>;
  ARTICLE_QUEUE: Queue<{ articleId: string; requestId: string; reason: "article_created" }>;
  GPT_RATE_LIMITER: RateLimit;
  GPT_OAUTH_CLIENT_ID: string;
  GPT_OAUTH_CLIENT_SECRET: string;
  GPT_OAUTH_AUTHORIZE_URL: string;
  SOURCE_CREDENTIALS_KEY?: string;
  GPT_DAILY_REQUEST_LIMIT: string;
  GPT_DAILY_WRITE_LIMIT: string;
  GPT_DAILY_TRANSLATION_LIMIT: string;
  GPT_TRANSLATION_CONCURRENCY: string;
}

function numericLimit(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeDaily(env: Env, metric: "requests" | "writes" | "translations", maximum: number): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(`INSERT INTO gpt_action_usage (owner_id, usage_date, metric, value, updated_at)
    VALUES (?1, ?2, ?3, 1, ?4) ON CONFLICT(owner_id, usage_date, metric) DO UPDATE SET
      value = value + 1, updated_at = excluded.updated_at RETURNING value`)
    .bind(REQUEST_OWNER, date, metric, new Date().toISOString()).first<{ value: number }>();
  if (Number(row?.value ?? maximum + 1) > maximum) {
    throw new ApiError(429, "daily_limit_exceeded", `GPT Action daily ${metric} limit has been reached`);
  }
}

async function consumeWrite(env: Env): Promise<void> {
  await consumeDaily(env, "writes", numericLimit(env.GPT_DAILY_WRITE_LIMIT, 50));
}

async function normalizeWriteRequest(request: Request): Promise<{ key: string; request: Request; bodyText: string }> {
  let input: Record<string, unknown>;
  try {
    input = await request.clone().json() as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "A JSON request body is required");
  }
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new ApiError(400, "invalid_json", "The JSON request body must be an object");
  }
  const key = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!key || key.length > 128) {
    throw new ApiError(400, "idempotency_key_required", "A valid idempotencyKey body field is required");
  }
  const normalizedInput = { ...input };
  delete normalizedInput.idempotencyKey;
  const bodyText = JSON.stringify(normalizedInput);
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Idempotency-Key", key);
  return { key, request: new Request(request, { body: bodyText, headers }), bodyText };
}

async function idempotentCreate(
  request: Request,
  env: Env,
  operation: (normalizedRequest: Request) => Promise<Response>,
): Promise<Response> {
  const normalized = await normalizeWriteRequest(request);
  const key = normalized.key;
  const url = new URL(request.url);
  const requestHash = await sha256(`${request.method}\n${url.pathname}\n${normalized.bodyText}`);
  const stored = await env.DB.prepare(`SELECT request_hash AS requestHash, response_status AS responseStatus,
      response_json AS responseJson FROM idempotency_requests
      WHERE owner_id = ?1 AND surface = 'gpt_action' AND idempotency_key = ?2 AND expires_at > ?3`)
    .bind(REQUEST_OWNER, key, new Date().toISOString())
    .first<{ requestHash: string; responseStatus: number; responseJson: string }>();
  if (stored) {
    if (stored.requestHash !== requestHash) {
      throw new ApiError(409, "idempotency_key_conflict", "Idempotency-Key was used for another request");
    }
    return new Response(stored.responseJson, {
      status: stored.responseStatus,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const response = await operation(normalized.request);
  if (response.status >= 200 && response.status < 300) {
    const responseJson = await response.clone().text();
    const created = new Date();
    await env.DB.prepare(`INSERT OR IGNORE INTO idempotency_requests
      (owner_id, surface, idempotency_key, request_hash, response_status, response_json, created_at, expires_at)
      VALUES (?1, 'gpt_action', ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(REQUEST_OWNER, key, requestHash, response.status, responseJson, created.toISOString(),
        new Date(created.getTime() + 24 * 60 * 60_000).toISOString()).run();
  }
  return response;
}

function clientEnv(env: Env): ClientApiEnv { return env as unknown as ClientApiEnv; }

async function route(request: Request, env: Env, id: string, identity: GptOAuthIdentity): Promise<Response> {
  const url = new URL(request.url);
  const requiredScope = request.method === "GET" ? "feedmind.read" : "feedmind.write";
  if (!identity.scopes.has(requiredScope)) {
    throw new ApiError(403, "insufficient_scope", `OAuth token does not grant ${requiredScope}`);
  }
  if (url.pathname.startsWith("/gpt-actions/v1/")) {
    url.pathname = `/v1/${url.pathname.slice("/gpt-actions/v1/".length)}`;
    request = new Request(url, request);
  }
  if (url.pathname === "/v1/articles" && request.method === "GET") return listArticles(request, clientEnv(env), id);
  if (url.pathname === "/v1/articles" && request.method === "POST") {
    await consumeWrite(env);
    return idempotentCreate(request, env, (normalized) => addArticle(normalized, clientEnv(env), id));
  }
  if (url.pathname === "/v1/subscriptions" && request.method === "POST") {
    await consumeWrite(env);
    return idempotentCreate(request, env, (normalized) => addSubscription(normalized, clientEnv(env), id));
  }
  if (url.pathname === "/v1/library/categories" && request.method === "POST") {
    await consumeWrite(env);
    return idempotentCreate(request, env, (normalized) => createCategory(normalized, clientEnv(env), id));
  }
  const article = url.pathname.match(/^\/v1\/articles\/([^/]+)$/);
  if (article && request.method === "GET") return getArticle(clientEnv(env), decodeURIComponent(article[1]), id);
  const articleContent = url.pathname.match(/^\/v1\/articles\/([^/]+)\/content$/);
  if (articleContent && request.method === "GET") return getArticleContent(request, clientEnv(env), decodeURIComponent(articleContent[1]), id);
  const translations = url.pathname.match(/^\/v1\/articles\/([^/]+)\/translations$/);
  if (translations) {
    const articleId = decodeURIComponent(translations[1]);
    if (request.method === "GET") return listTranslations(request, clientEnv(env), articleId, id);
    if (request.method === "POST") {
      await consumeWrite(env);
      const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM translations WHERE status IN ('pending', 'running', 'cancel_requested')")
        .first<{ count: number }>();
      const sameArticle = await env.DB.prepare(`SELECT id FROM translations WHERE article_id = ?1
        AND status IN ('pending', 'running', 'cancel_requested') LIMIT 1`).bind(articleId).first<{ id: string }>();
      if (!sameArticle && Number(active?.count ?? 0) >= numericLimit(env.GPT_TRANSLATION_CONCURRENCY, 2)) {
        throw new ApiError(429, "translation_concurrency_limit", "GPT Action translation concurrency limit has been reached");
      }
      await consumeDaily(env, "translations", numericLimit(env.GPT_DAILY_TRANSLATION_LIMIT, 10));
      return startTranslation((await normalizeWriteRequest(request)).request, clientEnv(env), articleId, id, "gpt_action");
    }
  }
  const translation = url.pathname.match(/^\/v1\/translations\/([^/]+)(?:\/(content|result|retry))?$/);
  if (translation) {
    const translationId = decodeURIComponent(translation[1]);
    if (!translation[2] && request.method === "GET") return getTranslation(clientEnv(env), translationId, id);
    if ((translation[2] === "content" || translation[2] === "result") && request.method === "GET") {
      return getTranslationContent(request, clientEnv(env), translationId, id);
    }
    if (translation[2] === "retry" && request.method === "POST") {
      await consumeWrite(env);
      const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM translations WHERE status IN ('pending', 'running', 'cancel_requested')")
        .first<{ count: number }>();
      if (Number(active?.count ?? 0) >= numericLimit(env.GPT_TRANSLATION_CONCURRENCY, 2)) {
        throw new ApiError(429, "translation_concurrency_limit", "GPT Action translation concurrency limit has been reached");
      }
      await consumeDaily(env, "translations", numericLimit(env.GPT_DAILY_TRANSLATION_LIMIT, 10));
      return retryTranslation((await normalizeWriteRequest(request)).request, clientEnv(env), translationId, id, "gpt_action");
    }
  }
  throw new ApiError(404, "not_found", "Endpoint not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = requestId(request);
    const url = new URL(request.url);
    if (url.pathname === "/openapi.json" && request.method === "GET") return json(openapi, id);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ data: { status: "ok", service: "gpt-actions-api" }, requestId: id }, id);
    }
    if (url.pathname === "/oauth/authorize" && request.method === "GET") {
      try {
        const destination = new URL(env.GPT_OAUTH_AUTHORIZE_URL);
        for (const [key, value] of url.searchParams) destination.searchParams.append(key, value);
        return new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: destination.toString() } });
      } catch { return oauthError("server_error", "OAuth authorization endpoint is not configured", 500); }
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      try {
        const key = `oauth:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
        if (!(await env.GPT_RATE_LIMITER.limit({ key })).success) {
          return oauthError("temporarily_unavailable", "OAuth token rate limit has been reached", 429);
        }
        return await oauthToken(request, env);
      }
      catch { return oauthError("server_error", "OAuth token request failed", 500); }
    }
    if (url.pathname === "/oauth/revoke" && request.method === "POST") {
      try {
        const key = `oauth:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
        if (!(await env.GPT_RATE_LIMITER.limit({ key })).success) {
          return oauthError("temporarily_unavailable", "OAuth revocation rate limit has been reached", 429);
        }
        return await oauthRevoke(request, env);
      }
      catch { return oauthError("server_error", "OAuth revocation request failed", 500); }
    }
    try {
      const identity = await oauthIdentity(request, env);
      env = { ...env, DB: scopedDatabase(env.DB, identity.ownerId) };
      if (!(await env.GPT_RATE_LIMITER.limit({ key: identity.ownerId })).success) {
        throw new ApiError(429, "rate_limit_exceeded", "GPT Action request rate limit has been reached");
      }
      await consumeDaily(env, "requests", numericLimit(env.GPT_DAILY_REQUEST_LIMIT, 1000));
      return await route(request, env, id, identity);
    } catch (error) {
      return errorResponse(error, id);
    }
  },
};
