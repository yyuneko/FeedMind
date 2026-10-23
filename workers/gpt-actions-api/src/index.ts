import type { D1Database, Queue, R2Bucket, WorkflowBinding } from "../../shared/src/cloudflare";
import { ApiError, errorResponse, json, requestId } from "../../shared/src/http";
import {
  addArticle, addSubscription, getArticle, getArticleContent, getSubscription, getTranslation, getTranslationContent,
  importOpml, listArticles, listSubscriptions, listTranslations, patchSubscription, refreshSubscription,
  type ClientApiEnv,
} from "../../c-api/src/routes";
import { createCategory, getLibraryTree, patchCategory, patchFeed } from "../../c-api/src/library";
import { REQUEST_OWNER, scopedDatabase } from "../../shared/src/scoped-db";
import { oauthError } from "../../shared/src/oauth";
import { oauthIdentity, oauthRevoke, oauthToken, type GptOAuthIdentity } from "./oauth";
import { handleMcpRequest } from "./mcp";
import { GPT_ACTION_PROFILE_ID, getArticlePreprocessingContext, saveArticlePreprocessing } from "./preprocessing";
import {
  getArticleImageTranslation, listArticleImages, readArticleImage, saveArticleImageTranslation,
} from "./image-translations";

export interface Env {
  DB: D1Database;
  CONTENT: R2Bucket;
  BODY_TRANSLATION_WORKFLOW: WorkflowBinding<{ translationId: string; attemptId: string; requestId: string }>;
  FEED_QUEUE: Queue<{ feedId: string; requestId: string; reason: "subscription_created" | "manual_refresh" }>;
  ARTICLE_QUEUE: Queue<{ articleId: string; requestId: string; reason: "article_created" }>;
  GPT_OAUTH_CLIENT_ID: string;
  GPT_OAUTH_CLIENT_SECRET: string;
  GPT_OAUTH_AUTHORIZE_URL: string;
  SOURCE_CREDENTIALS_KEY?: string;
  MIGRATION_MODE?: string;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
    return new Response([204, 205, 304].includes(stored.responseStatus) ? null : stored.responseJson, {
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

function requiredText(input: Record<string, unknown>, key: string, maximum: number): string {
  const candidate = input[key];
  const value = typeof candidate === "string" ? candidate.trim() : "";
  if (!value || value.length > maximum) {
    throw new ApiError(400, "invalid_translation_input", `${key} must contain between 1 and ${maximum} characters`);
  }
  return value;
}

function targetLocale(input: Record<string, unknown>): "zh-CN" | "en-US" | "ja-JP" {
  const locale = typeof input.targetLocale === "string" && input.targetLocale.trim()
    ? input.targetLocale.trim()
    : "zh-CN";
  if (locale !== "zh-CN" && locale !== "en-US" && locale !== "ja-JP") {
    throw new ApiError(400, "invalid_localization_input", "targetLocale must be zh-CN, en-US, or ja-JP");
  }
  return locale;
}

async function localizedArticleContext(env: Env, articleId: string): Promise<{ sourceHash: string }> {
  const article = await env.DB.prepare(`SELECT a.source_hash AS sourceHash FROM articles a
    WHERE a.id = ?1 AND a.owner_id = ?2 AND a.parse_status = 'completed' AND a.source_hash IS NOT NULL AND (
      (EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?2 AND s.is_active = 1)
       AND EXISTS (SELECT 1 FROM account_source_selections selection JOIN source_connections connection
         ON connection.id = selection.active_connection_id
         WHERE selection.owner_id = ?2 AND connection.connector_type = 'direct_rss'))
      OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
        WHERE si.article_id = a.id AND si.owner_id = ?2 AND src.enabled = 1
          AND si.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?2)))`)
    .bind(articleId, REQUEST_OWNER).first<{ sourceHash: string }>();
  if (!article) {
    throw new ApiError(409, "article_localization_unavailable", "Article must be accessible and fully parsed first");
  }
  return article;
}

function upsertArticleLocalization(
  env: Env,
  input: {
    articleId: string;
    targetLocale: string;
    sourceHash: string;
    translatedTitle: string | null;
    summary: string | null;
    requestId: string;
    timestamp: string;
  },
) {
  return env.DB.prepare(`INSERT INTO article_gpt_localizations
      (owner_id, article_id, target_locale, source_hash, translated_title, one_line_summary,
       created_by, request_id, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'gpt_action', ?7, ?8, ?8)
    ON CONFLICT(owner_id, article_id, target_locale) DO UPDATE SET
      source_hash = excluded.source_hash,
      translated_title = CASE WHEN excluded.translated_title IS NULL
        THEN article_gpt_localizations.translated_title ELSE excluded.translated_title END,
      one_line_summary = CASE WHEN excluded.one_line_summary IS NULL
        THEN article_gpt_localizations.one_line_summary ELSE excluded.one_line_summary END,
      created_by = 'gpt_action', request_id = excluded.request_id, updated_at = excluded.updated_at`)
    .bind(REQUEST_OWNER, input.articleId, input.targetLocale, input.sourceHash, input.translatedTitle,
      input.summary, input.requestId, input.timestamp);
}

async function saveSuppliedArticleLocalization(
  request: Request,
  env: Env,
  articleId: string,
  requestIdValue: string,
  field: "translatedTitle" | "summary",
): Promise<Response> {
  let input: Record<string, unknown>;
  try {
    input = await request.json() as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "A JSON request body is required");
  }
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new ApiError(400, "invalid_json", "The JSON request body must be an object");
  }
  const locale = targetLocale(input);
  const content = requiredText(input, field, field === "translatedTitle" ? 1000 : 4000);
  const context = await localizedArticleContext(env, articleId);
  const now = new Date().toISOString();
  const title = field === "translatedTitle" ? content : null;
  const summary = field === "summary" ? content : null;
  await upsertArticleLocalization(env, {
    articleId,
    targetLocale: locale,
    sourceHash: context.sourceHash,
    translatedTitle: title,
    summary,
    requestId: requestIdValue,
    timestamp: now,
  }).run();
  return json({ data: {
    articleId,
    targetLocale: locale,
    sourceHash: context.sourceHash,
    status: "completed",
    [field]: content,
    updatedAt: now,
  }, requestId: requestIdValue }, requestIdValue, 201);
}

async function saveSuppliedTranslation(
  request: Request,
  env: Env,
  articleId: string,
  requestIdValue: string,
): Promise<Response> {
  let input: Record<string, unknown>;
  try {
    input = await request.json() as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "A JSON request body is required");
  }
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new ApiError(400, "invalid_json", "The JSON request body must be an object");
  }
  const targetLocale = typeof input.targetLocale === "string" && input.targetLocale.trim()
    ? input.targetLocale.trim()
    : "zh-CN";
  if (targetLocale.length > 35) {
    throw new ApiError(400, "invalid_translation_input", "targetLocale must not exceed 35 characters");
  }
  const translatedTitle = requiredText(input, "translatedTitle", 1000);
  const translatedContent = requiredText(input, "translatedContent", 5_000_000);
  const promptVersionId = requiredText(input, "promptVersionId", 100);
  const context = await env.DB.prepare(`SELECT a.source_hash AS sourceHash,
      c.article_type AS articleType, c.title_profile_version_id AS titleProfileVersionId,
      p.id AS promptVersionId, ?5 AS bodyProfileVersionId
    FROM articles a
    JOIN article_classifications c ON c.article_id = a.id AND c.source_hash = a.source_hash AND c.is_current = 1
    JOIN prompt_definitions d ON d.task = 'body_translation' AND d.article_type = c.article_type
      AND d.target_locale = ?2 AND d.deleted_at IS NULL
    JOIN prompt_versions p ON p.id = d.current_version_id AND p.status = 'active' AND p.id = ?4
    WHERE a.id = ?1 AND a.owner_id = ?3 AND a.parse_status = 'completed' AND (
      (EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?3 AND s.is_active = 1)
       AND EXISTS (SELECT 1 FROM account_source_selections selection JOIN source_connections connection
         ON connection.id = selection.active_connection_id
         WHERE selection.owner_id = ?3 AND connection.connector_type = 'direct_rss'))
      OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
        WHERE si.article_id = a.id AND si.owner_id = ?3 AND src.enabled = 1
          AND si.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?3)))`)
    .bind(articleId, targetLocale, REQUEST_OWNER, promptVersionId, GPT_ACTION_PROFILE_ID)
    .first<{ sourceHash: string; articleType: string; titleProfileVersionId: string;
      promptVersionId: string; bodyProfileVersionId: string }>();
  if (!context) {
    throw new ApiError(409, "article_translation_unavailable",
      "Article must be parsed and classified, and promptVersionId must match its current active translation prompt");
  }
  const existing = await env.DB.prepare(`SELECT id, status, translated_title AS translatedTitle,
      retry_count AS retryCount, created_at AS createdAt, completed_at AS completedAt
    FROM translations WHERE owner_id = ?1 AND article_id = ?2 AND target_locale = ?3 AND source_hash = ?4
    ORDER BY created_at DESC LIMIT 1`)
    .bind(REQUEST_OWNER, articleId, targetLocale, context.sourceHash)
    .first<{ id: string; status: string; translatedTitle: string | null; retryCount: number;
      createdAt: string; completedAt: string | null }>();
  if (existing?.status === "completed") {
    return json({ data: {
      ...existing, articleId, targetLocale, articleType: context.articleType,
      sourceHash: context.sourceHash,
    }, reused: true, pollAfterSeconds: 0, nextRequiredAction: imageTranslationNextAction(articleId, targetLocale),
    requestId: requestIdValue }, requestIdValue);
  }
  if (existing && ["pending", "running", "cancel_requested"].includes(existing.status)) {
    throw new ApiError(409, "translation_active", "An active translation already exists for this article and locale");
  }

  const translationId = existing?.id ?? crypto.randomUUID();
  const resultKey = `translations/${translationId}/result.json`;
  const contentHtmlKey = `translations/${translationId}/content.html`;
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const completedAt = new Date().toISOString();
  const latestAttempt = existing
    ? await env.DB.prepare(`SELECT COALESCE(MAX(attempt), 0) AS attempt FROM translation_attempts
        WHERE translation_id = ?1`).bind(translationId).first<{ attempt: number }>()
    : null;
  const attemptNumber = Number(latestAttempt?.attempt ?? 0) + 1;
  const attemptId = crypto.randomUUID();
  const retryCount = existing ? Number(existing.retryCount ?? 0) + 1 : 0;
  const result = JSON.stringify({
    v: 2,
    title: translatedTitle,
    sourceHash: context.sourceHash,
    promptVersionId: context.promptVersionId,
    externallySupplied: true,
    blocks: [],
  });
  try {
    await Promise.all([
      env.CONTENT.put(resultKey, result, { httpMetadata: { contentType: "application/json; charset=utf-8" } }),
      env.CONTENT.put(contentHtmlKey, translatedContent, { httpMetadata: { contentType: "text/html; charset=utf-8" } }),
    ]);
    const translationWrite = existing
      ? env.DB.prepare(`UPDATE translations SET status = 'completed', translated_title = ?1,
        result_key = ?2, result_hash = ?3, result_bytes = ?4, content_html_key = ?5,
        trigger_reason = 'gpt_supplied_translation', created_by = 'gpt_action', request_id = ?6,
        retry_count = retry_count + 1, workflow_instance_id = NULL, cancel_requested_at = NULL,
        started_at = ?7, completed_at = ?7
        WHERE id = ?8 AND status IN ('failed', 'cancelled', 'superseded')`)
        .bind(translatedTitle, resultKey, context.sourceHash, new TextEncoder().encode(result).byteLength,
          contentHtmlKey, requestIdValue, completedAt, translationId)
      : env.DB.prepare(`INSERT INTO translations
        (id, owner_id, article_id, target_locale, article_type, status, source_hash, translated_title,
         prompt_version_id, title_profile_version_id, body_profile_version_id, trigger_reason,
         result_key, result_hash, result_bytes, content_html_key, retry_count, created_by,
         request_id, created_at, started_at, completed_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, ?7, ?8, ?9, ?10,
          'gpt_supplied_translation', ?11, ?12, ?13, ?14, 0, 'gpt_action', ?15, ?16, ?17, ?17)`)
        .bind(translationId, REQUEST_OWNER, articleId, targetLocale, context.articleType, context.sourceHash,
          translatedTitle, context.promptVersionId, context.titleProfileVersionId, context.bodyProfileVersionId,
          resultKey, context.sourceHash, new TextEncoder().encode(result).byteLength, contentHtmlKey,
          requestIdValue, createdAt, completedAt);
    await env.DB.batch([
      translationWrite,
      env.DB.prepare(`INSERT INTO translation_attempts
        (id, translation_id, attempt, status, input_tokens, output_tokens, thinking_tokens,
         provider_latency_ms, created_at, started_at, completed_at)
        VALUES (?1, ?2, ?3, 'completed', 0, 0, 0, 0, ?4, ?4, ?4)`)
        .bind(attemptId, translationId, attemptNumber, completedAt),
      upsertArticleLocalization(env, {
        articleId,
        targetLocale,
        sourceHash: context.sourceHash,
        translatedTitle,
        summary: null,
        requestId: requestIdValue,
        timestamp: completedAt,
      }),
    ]);
  } catch (error) {
    await env.CONTENT.delete([resultKey, contentHtmlKey]);
    throw error;
  }
  return json({ data: {
    id: translationId,
    articleId,
    targetLocale,
    articleType: context.articleType,
    status: "completed",
    sourceHash: context.sourceHash,
    translatedTitle,
    retryCount,
    workflowInstanceId: null,
    createdAt,
    startedAt: completedAt,
    completedAt,
  }, reused: false, pollAfterSeconds: 0, nextRequiredAction: imageTranslationNextAction(articleId, targetLocale),
  requestId: requestIdValue }, requestIdValue, 201);
}

async function getArticleTranslationPrompt(
  env: Env,
  articleId: string,
  targetLocale: string,
  requestIdValue: string,
): Promise<Response> {
  const prompt = await env.DB.prepare(`SELECT c.article_type AS articleType,
      p.id AS promptVersionId, p.content AS prompt
    FROM articles a
    JOIN article_classifications c ON c.article_id = a.id AND c.source_hash = a.source_hash AND c.is_current = 1
    JOIN prompt_definitions d ON d.task = 'body_translation' AND d.article_type = c.article_type
      AND d.target_locale = ?2 AND d.deleted_at IS NULL
    JOIN prompt_versions p ON p.id = d.current_version_id AND p.status = 'active'
    WHERE a.id = ?1 AND a.owner_id = ?3 AND a.parse_status = 'completed' AND (
      (EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?3 AND s.is_active = 1)
       AND EXISTS (SELECT 1 FROM account_source_selections selection JOIN source_connections connection
         ON connection.id = selection.active_connection_id
         WHERE selection.owner_id = ?3 AND connection.connector_type = 'direct_rss'))
      OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
        WHERE si.article_id = a.id AND si.owner_id = ?3 AND src.enabled = 1
          AND si.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?3)))`)
    .bind(articleId, targetLocale, REQUEST_OWNER)
    .first<{ articleType: string; promptVersionId: string; prompt: string }>();
  if (!prompt) {
    throw new ApiError(404, "translation_prompt_unavailable",
      "No active translation prompt is available for this article classification and target locale");
  }
  return json({ data: {
    articleId,
    targetLocale,
    ...prompt,
    companionImageTranslation: imageTranslationNextAction(articleId, targetLocale),
  }, requestId: requestIdValue }, requestIdValue);
}

function clientEnv(env: Env): ClientApiEnv { return env as unknown as ClientApiEnv; }

function imageTranslationNextAction(articleId: string, targetLocale: string) {
  return {
    required: true,
    tool: "listArticleImages",
    arguments: { articleId },
    targetLocale,
    instruction: "The article translation task is not complete until every static article image has been reviewed and every image containing meaningful text has been translated for this targetLocale.",
  };
}

async function listUntranslatedArticles(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const targetLocale = (url.searchParams.get("targetLocale") ?? "zh-CN").trim();
  if (!['zh-CN', 'en-US', 'ja-JP'].includes(targetLocale)) {
    throw new ApiError(422, "validation_failed", "targetLocale must be zh-CN, en-US, or ja-JP");
  }
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10);
  if (!Number.isInteger(page) || page < 1 || page > 10000) {
    throw new ApiError(422, "validation_failed", "page must be an integer between 1 and 10000");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ApiError(422, "validation_failed", "pageSize must be an integer between 1 and 100");
  }
  const feedId = (url.searchParams.get("feedId") ?? "").trim().slice(0, 100);
  const query = (url.searchParams.get("query") ?? "").trim().slice(0, 200);
  const queryPattern = `%${query}%`;
  const offset = (page - 1) * pageSize;
  const where = `a.owner_id = ?1 AND a.parse_status = 'completed' AND a.source_hash IS NOT NULL
    AND (
      (EXISTS (SELECT 1 FROM account_source_selections selection JOIN source_connections connection
        ON connection.id = selection.active_connection_id
        WHERE selection.owner_id = ?1 AND connection.connector_type = 'direct_rss')
       AND EXISTS (SELECT 1 FROM subscriptions subscription
        WHERE subscription.feed_id = a.feed_id AND subscription.owner_id = ?1 AND subscription.is_active = 1))
      OR EXISTS (SELECT 1 FROM source_items item JOIN sources source ON source.id = item.source_id
        WHERE item.article_id = a.id AND item.owner_id = ?1 AND source.enabled = 1
          AND item.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?1)))
    AND (?3 = '' OR a.feed_id = ?3 OR EXISTS (
      SELECT 1 FROM source_items feed_item WHERE feed_item.article_id = a.id AND feed_item.source_id = ?3))
    AND (?4 = '' OR a.title LIKE ?5)
    AND NOT EXISTS (SELECT 1 FROM translations translation
      WHERE translation.owner_id = ?1 AND translation.article_id = a.id
        AND translation.target_locale = ?2 AND translation.source_hash = a.source_hash
        AND translation.status = 'completed')`;
  const bindings = [REQUEST_OWNER, targetLocale, feedId, query, queryPattern];
  const result = await env.DB.prepare(`SELECT a.id, a.feed_id AS feedId,
      COALESCE((SELECT NULLIF(subscription.custom_title, '') FROM subscriptions subscription
        WHERE subscription.feed_id = a.feed_id AND subscription.owner_id = ?1 LIMIT 1),
        (SELECT feed.title FROM feeds feed WHERE feed.id = a.feed_id LIMIT 1),
        (SELECT COALESCE(NULLIF(source.custom_title, ''), source.title)
          FROM source_items item JOIN sources source ON source.id = item.source_id
          WHERE item.article_id = a.id ORDER BY item.first_seen_at LIMIT 1)) AS feedTitle,
      a.title, a.canonical_url AS url, a.author, a.published_at AS publishedAt,
      a.source_hash AS sourceHash,
      (SELECT classification.article_type FROM article_classifications classification
        WHERE classification.article_id = a.id AND classification.source_hash = a.source_hash
          AND classification.is_current = 1 LIMIT 1) AS articleType,
      CASE WHEN EXISTS (SELECT 1 FROM article_preprocessing_runs preprocessing
        WHERE preprocessing.article_id = a.id AND preprocessing.is_current = 1)
        THEN 'completed' ELSE COALESCE((SELECT CASE WHEN task.error_code = 'content_too_large'
          THEN 'content_too_large' ELSE task.status END FROM article_preprocessing_tasks task
          WHERE task.article_id = a.id ORDER BY task.created_at DESC LIMIT 1), 'missing') END AS preprocessingStatus,
      CASE WHEN EXISTS (SELECT 1 FROM article_classifications classification
        JOIN prompt_definitions definition ON definition.task = 'body_translation'
          AND definition.article_type = classification.article_type AND definition.target_locale = ?2
          AND definition.deleted_at IS NULL
        JOIN prompt_versions prompt ON prompt.id = definition.current_version_id AND prompt.status = 'active'
        WHERE classification.article_id = a.id AND classification.source_hash = a.source_hash
          AND classification.is_current = 1) THEN 1 ELSE 0 END AS translationReady,
      (SELECT translation.status FROM translations translation
        WHERE translation.owner_id = ?1 AND translation.article_id = a.id
          AND translation.target_locale = ?2 AND translation.source_hash = a.source_hash
        ORDER BY translation.created_at DESC LIMIT 1) AS translationStatus
    FROM articles a WHERE ${where}
    ORDER BY a.published_at DESC, a.id DESC LIMIT ?6 OFFSET ?7`)
    .bind(...bindings, pageSize + 1, offset).all<Record<string, unknown>>();
  const items = result.results ?? [];
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM articles a WHERE ${where}`)
    .bind(...bindings).first<{ total: number }>();
  return json({
    items: items.slice(0, pageSize).map((item) => ({
      ...item,
      translationReady: Number(item.translationReady ?? 0) === 1,
    })),
    page,
    pageSize,
    hasMore: items.length > pageSize,
    total: Number(count?.total ?? 0),
    targetLocale,
    requestId: requestIdValue,
  }, requestIdValue);
}

async function route(request: Request, env: Env, id: string, identity: GptOAuthIdentity): Promise<Response> {
  const url = new URL(request.url);
  const requiredScope = request.method === "GET" ? "feedmind.read" : "feedmind.write";
  if (!identity.scopes.has(requiredScope)) {
    throw new ApiError(403, "insufficient_scope", `OAuth token does not grant ${requiredScope}`);
  }
  if (url.pathname.startsWith("/internal/v1/")) {
    url.pathname = `/v1/${url.pathname.slice("/internal/v1/".length)}`;
    request = new Request(url, request);
  }
  if (url.pathname === "/v1/articles" && request.method === "GET") return listArticles(request, clientEnv(env), id);
  if (url.pathname === "/v1/articles/untranslated" && request.method === "GET") {
    return listUntranslatedArticles(request, env, id);
  }
  if (url.pathname === "/v1/articles" && request.method === "POST") {
    return idempotentCreate(request, env, (normalized) => addArticle(normalized, clientEnv(env), id));
  }
  if (url.pathname === "/v1/subscriptions" && request.method === "POST") {
    return idempotentCreate(request, env, (normalized) => addSubscription(normalized, clientEnv(env), id));
  }
  if (url.pathname === "/v1/subscriptions" && request.method === "GET") {
    return listSubscriptions(request, clientEnv(env), id);
  }
  const subscription = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)(?:\/(refresh|refresh-title))?$/);
  if (subscription) {
    const subscriptionId = decodeURIComponent(subscription[1]);
    if (!subscription[2] && request.method === "GET") return getSubscription(clientEnv(env), subscriptionId, id);
    if (!subscription[2] && request.method === "PATCH") {
      return idempotentCreate(request, env,
        (normalized) => patchSubscription(normalized, clientEnv(env), subscriptionId, id));
    }
    if (subscription[2] && request.method === "POST") {
      return idempotentCreate(request, env,
        () => refreshSubscription(clientEnv(env), subscriptionId, id));
    }
  }
  if (url.pathname === "/v1/opml/import" && request.method === "POST") {
    return idempotentCreate(request, env, (normalized) => importOpml(normalized, clientEnv(env), id));
  }
  if (url.pathname === "/v1/library/tree" && request.method === "GET") {
    return getLibraryTree(clientEnv(env), id);
  }
  if (url.pathname === "/v1/library/categories" && request.method === "POST") {
    return idempotentCreate(request, env, (normalized) => createCategory(normalized, clientEnv(env), id));
  }
  const category = url.pathname.match(/^\/v1\/library\/categories\/([^/]+)$/);
  if (category && request.method === "PATCH") {
    const categoryId = decodeURIComponent(category[1]);
    return idempotentCreate(request, env,
      (normalized) => patchCategory(normalized, clientEnv(env), categoryId));
  }
  const libraryFeed = url.pathname.match(/^\/v1\/library\/feeds\/([^/]+)$/);
  if (libraryFeed && request.method === "PATCH") {
    const feedId = decodeURIComponent(libraryFeed[1]);
    return idempotentCreate(request, env,
      (normalized) => patchFeed(normalized, clientEnv(env), feedId));
  }
  const article = url.pathname.match(/^\/v1\/articles\/([^/]+)$/);
  if (article && request.method === "GET") return getArticle(clientEnv(env), decodeURIComponent(article[1]), id);
  const articleContent = url.pathname.match(/^\/v1\/articles\/([^/]+)\/content$/);
  if (articleContent && request.method === "GET") return getArticleContent(request, clientEnv(env), decodeURIComponent(articleContent[1]), id);
  const articleImages = url.pathname.match(/^\/v1\/articles\/([^/]+)\/images$/);
  if (articleImages && request.method === "GET") {
    return listArticleImages(env, decodeURIComponent(articleImages[1]), id);
  }
  const articleImage = url.pathname.match(/^\/v1\/articles\/([^/]+)\/images\/([^/]+)$/);
  if (articleImage && request.method === "GET") {
    return readArticleImage(env, decodeURIComponent(articleImage[1]), decodeURIComponent(articleImage[2]));
  }
  const imageTranslation = url.pathname.match(/^\/v1\/articles\/([^/]+)\/image-translations\/([^/]+)$/);
  if (imageTranslation) {
    const articleId = decodeURIComponent(imageTranslation[1]);
    const imageId = decodeURIComponent(imageTranslation[2]);
    if (request.method === "GET") {
      return getArticleImageTranslation(env, articleId, imageId,
        url.searchParams.get("targetLocale") ?? "zh-CN", id);
    }
    if (request.method === "POST") {
      return idempotentCreate(request, env,
        (normalized) => saveArticleImageTranslation(normalized, env, articleId, imageId, id));
    }
  }
  const articlePreprocessingContext = url.pathname.match(/^\/v1\/articles\/([^/]+)\/preprocessing-context$/);
  if (articlePreprocessingContext && request.method === "GET") {
    return getArticlePreprocessingContext(env, decodeURIComponent(articlePreprocessingContext[1]), id);
  }
  const articlePreprocessing = url.pathname.match(/^\/v1\/articles\/([^/]+)\/preprocessing$/);
  if (articlePreprocessing && request.method === "POST") {
    const articleId = decodeURIComponent(articlePreprocessing[1]);
    return idempotentCreate(request, env, (normalized) => saveArticlePreprocessing(normalized, env, articleId, id));
  }
  const titleTranslation = url.pathname.match(/^\/v1\/articles\/([^/]+)\/title-translation$/);
  if (titleTranslation && request.method === "POST") {
    const articleId = decodeURIComponent(titleTranslation[1]);
    return idempotentCreate(request, env,
      (normalized) => saveSuppliedArticleLocalization(normalized, env, articleId, id, "translatedTitle"));
  }
  const summary = url.pathname.match(/^\/v1\/articles\/([^/]+)\/summary$/);
  if (summary && request.method === "POST") {
    const articleId = decodeURIComponent(summary[1]);
    return idempotentCreate(request, env,
      (normalized) => saveSuppliedArticleLocalization(normalized, env, articleId, id, "summary"));
  }
  const translations = url.pathname.match(/^\/v1\/articles\/([^/]+)\/translations$/);
  if (translations) {
    const articleId = decodeURIComponent(translations[1]);
    if (request.method === "GET") return listTranslations(request, clientEnv(env), articleId, id);
    if (request.method === "POST") {
      return idempotentCreate(request, env,
        (normalized) => saveSuppliedTranslation(normalized, env, articleId, id));
    }
  }
  const translationPrompt = url.pathname.match(/^\/v1\/articles\/([^/]+)\/translation-prompt$/);
  if (translationPrompt && request.method === "GET") {
    const targetLocale = (url.searchParams.get("targetLocale") ?? "zh-CN").trim().slice(0, 35) || "zh-CN";
    return getArticleTranslationPrompt(env, decodeURIComponent(translationPrompt[1]), targetLocale, id);
  }
  const translation = url.pathname.match(/^\/v1\/translations\/([^/]+)(?:\/(content|result))?$/);
  if (translation) {
    const translationId = decodeURIComponent(translation[1]);
    if (!translation[2] && request.method === "GET") return getTranslation(clientEnv(env), translationId, id);
    if ((translation[2] === "content" || translation[2] === "result") && request.method === "GET") {
      return getTranslationContent(request, clientEnv(env), translationId, id);
    }
  }
  throw new ApiError(404, "not_found", "Endpoint not found");
}

function oauthMetadata(request: Request): Response {
  const origin = new URL(request.url).origin;
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: ["feedmind.read", "feedmind.write", "offline_access"],
  }, { headers: { "Cache-Control": "public, max-age=300" } });
}

function protectedResourceMetadata(request: Request): Response {
  const origin = new URL(request.url).origin;
  return Response.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["feedmind.read", "feedmind.write", "offline_access"],
  }, { headers: { "Cache-Control": "public, max-age=300" } });
}

export async function actionsFetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-authorization-server" && request.method === "GET") return oauthMetadata(request);
    if ((url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")
      && request.method === "GET") return protectedResourceMetadata(request);
    if (url.pathname === "/mcp") {
      return handleMcpRequest(request, (action) => invokeMcpAction(action, env));
    }
    if (env.MIGRATION_MODE === "paused" || (env.MIGRATION_MODE === "read_only" && request.method !== "GET")) {
      return new Response(JSON.stringify({ error: { code: "migration_in_progress", message: "FeedMind is temporarily read-only during migration" } }), {
        status: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "300" },
      });
    }
    const id = requestId(request);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ data: { status: "ok", service: "gpt-actions-api" }, requestId: id }, id);
    }
    if (url.pathname === "/oauth/authorize" && request.method === "GET") {
      try {
        const destination = new URL(env.GPT_OAUTH_AUTHORIZE_URL);
        url.searchParams.forEach((value, key) => destination.searchParams.append(key, value));
        return new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: destination.toString() } });
      } catch { return oauthError("server_error", "OAuth authorization endpoint is not configured", 500); }
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      try {
        return await oauthToken(request, env);
      }
      catch { return oauthError("server_error", "OAuth token request failed", 500); }
    }
    if (url.pathname === "/oauth/revoke" && request.method === "POST") {
      try {
        return await oauthRevoke(request, env);
      }
      catch { return oauthError("server_error", "OAuth revocation request failed", 500); }
    }
    return errorResponse(new ApiError(404, "not_found", "Endpoint not found"), id);
}

async function invokeMcpAction(request: Request, env: Env): Promise<Response> {
  const id = requestId(request);
  try {
    if (env.MIGRATION_MODE === "paused" || (env.MIGRATION_MODE === "read_only" && request.method !== "GET")) {
      throw new ApiError(503, "migration_in_progress", "FeedMind is temporarily read-only during migration");
    }
    const identity = await oauthIdentity(request, env);
    const scopedEnv = { ...env, DB: scopedDatabase(env.DB, identity.ownerId) };
    return await route(request, scopedEnv, id, identity);
  } catch (error) {
    return errorResponse(error, id);
  }
}

export default {
  fetch: actionsFetch,
};
