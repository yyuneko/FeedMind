import type { AccessIdentity } from "../../shared/src/auth";
import type { D1Database, Fetcher, Queue, R2Bucket, WorkflowBinding } from "../../shared/src/cloudflare";
import type { AccessApiEnv } from "../../shared/src/api";
import { fetchContent } from "../../shared/src/content-fetch";
import { alignContentBlocks, annotateAndHideContentBlocks, contentHtmlToText,
  type AlignableContentBlock } from "../../shared/src/content-blocks";
import { ApiError, json } from "../../shared/src/http";
import { contentWindow, normalizeHttpUrl, pagination, readJsonObject, sliceCodePoints, stringField } from "./validation";
import { routeClientState } from "./client-state";
import { activeConnection, createExternalSubscription, deleteExternalSubscription,
  routeSources, updateExternalSubscription } from "./sources";
import { routeLibrary } from "./library";
import { authorizeGptAction } from "./oauth";
import { ensureAccount } from "../../shared/src/accounts";
import { REQUEST_OWNER, scopedDatabase } from "../../shared/src/scoped-db";

const OWNER_ID = REQUEST_OWNER;

export interface ClientApiEnv extends AccessApiEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
  FEED_QUEUE: Queue<FeedQueueMessage | SourceQueueMessage | SourceSwitchQueueMessage>;
  ARTICLE_QUEUE: Queue<ArticleQueueMessage>;
  AI_SERVICE: Fetcher;
  BODY_TRANSLATION_WORKFLOW: WorkflowBinding<{ translationId: string; attemptId: string; requestId: string }>;
  SOURCE_CREDENTIALS_KEY?: string;
  READER_CREDENTIALS_KEY?: string;
  GPT_OAUTH_CLIENT_ID: string;
  GPT_OAUTH_REDIRECT_URIS: string;
}

interface FeedQueueMessage {
  feedId: string;
  requestId: string;
  reason: "subscription_created" | "manual_refresh";
}

interface SourceQueueMessage {
  connectionId: string;
  sourceId?: string;
  selectionRevision?: number;
  requestId: string;
  reason: string;
}

interface SourceSwitchQueueMessage {
  switchJobId: string;
  requestId: string;
  reason: "source_switch";
}

interface ArticleQueueMessage {
  articleId: string;
  requestId: string;
  reason: "article_created";
}

function now(): string {
  return new Date().toISOString();
}

async function rows<T>(env: ClientApiEnv, sql: string, bindings: unknown[] = []): Promise<T[]> {
  const result = await env.DB.prepare(sql).bind(...bindings).all<T>();
  if (!result.success) throw new ApiError(500, "database_error", "Database query failed");
  return result.results ?? [];
}

async function first<T>(env: ClientApiEnv, sql: string, bindings: unknown[] = []): Promise<T | null> {
  return env.DB.prepare(sql).bind(...bindings).first<T>();
}

async function requestOwnerId(env: ClientApiEnv): Promise<string> {
  const row = await first<{ id: string }>(env, "SELECT id FROM accounts WHERE id = ?1", [OWNER_ID]);
  if (!row?.id) throw new ApiError(500, "account_unavailable", "Request account is unavailable");
  return row.id;
}

function boolean(value: unknown): boolean {
  return value === true || value === 1;
}

function subscriptionPath(pathname: string): { id: string; action?: "refresh" | "refresh-title" } | undefined {
  const match = pathname.match(/^\/v1\/subscriptions\/([^/]+)(?:\/(refresh|refresh-title))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] as "refresh" | "refresh-title" | undefined } : undefined;
}

function articlePath(pathname: string): { id: string; action?: "state" | "content" } | undefined {
  const match = pathname.match(/^\/v1\/articles\/([^/]+)(?:\/(state|content))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] as "state" | "content" | undefined } : undefined;
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function idempotentResponse(
  request: Request,
  env: ClientApiEnv,
  requestHash: string,
  surface: "client" | "gpt_action",
): Promise<Response | null> {
  const key = request.headers.get("Idempotency-Key")?.trim();
  if (!key || key.length > 128) throw new ApiError(400, "idempotency_key_required", "A valid Idempotency-Key header is required");
  const stored = await first<{ requestHash: string; responseStatus: number; responseJson: string }>(env, `
    SELECT request_hash AS requestHash, response_status AS responseStatus, response_json AS responseJson
    FROM idempotency_requests WHERE owner_id = ?1 AND surface = ?2 AND idempotency_key = ?3 AND expires_at > ?4`,
  [OWNER_ID, surface, key, now()]);
  if (!stored) return null;
  if (stored.requestHash !== requestHash) throw new ApiError(409, "idempotency_key_conflict", "Idempotency-Key was used for another request");
  return new Response(stored.responseJson, {
    status: stored.responseStatus,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function storeIdempotentResponse(
  request: Request,
  env: ClientApiEnv,
  requestHash: string,
  status: number,
  payload: unknown,
  surface: "client" | "gpt_action",
): Promise<void> {
  const key = request.headers.get("Idempotency-Key")!.trim();
  const created = now();
  const expires = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO idempotency_requests
    (owner_id, surface, idempotency_key, request_hash, response_status, response_json, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .bind(OWNER_ID, surface, key, requestHash, status, JSON.stringify(payload), created, expires).run();
}

async function listSubscriptions(request: Request, env: ClientApiEnv, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const { page, pageSize, offset } = pagination(url);
  const query = (url.searchParams.get("query") ?? "").trim().slice(0, 200);
  const like = `%${query}%`;
  const active = await activeConnection(env, OWNER_ID);
  if (active.type !== "direct_rss") {
    const values = await rows<Record<string, unknown>>(env, `SELECT src.id, src.id AS feedId,
      COALESCE(NULLIF(src.custom_title, ''), src.title) AS title, COALESCE(src.url, '') AS url,
      src.site_url AS siteUrl, COALESCE(category.name, '') AS category,
      src.library_sort_order AS sortOrder, src.enabled,
      CASE src.sync_status WHEN 'syncing' THEN 'fetching' WHEN 'ok' THEN 'ok'
        WHEN 'error' THEN 'error' ELSE 'pending' END AS fetchStatus,
      (SELECT COUNT(*) FROM source_items item WHERE item.source_id = src.id) AS articleCount,
      src.created_at AS createdAt, src.updated_at AS updatedAt
      FROM sources src LEFT JOIN library_categories category ON category.id = src.library_category_id
      WHERE src.owner_id = ?1 AND src.connection_id = ?2 AND src.enabled = 1
        AND (?3 = '' OR COALESCE(NULLIF(src.custom_title, ''), src.title) LIKE ?4 OR src.url LIKE ?4 OR category.name LIKE ?4)
      ORDER BY src.library_sort_order, lower(COALESCE(NULLIF(src.custom_title, ''), src.title)), src.id
      LIMIT ?5 OFFSET ?6`, [OWNER_ID, active.id, query, like, pageSize + 1, offset]);
    const count = await first<{ total: number }>(env, `SELECT COUNT(*) AS total FROM sources src
      LEFT JOIN library_categories category ON category.id = src.library_category_id
      WHERE src.owner_id = ?1 AND src.connection_id = ?2 AND src.enabled = 1
        AND (?3 = '' OR COALESCE(NULLIF(src.custom_title, ''), src.title) LIKE ?4 OR src.url LIKE ?4 OR category.name LIKE ?4)`,
    [OWNER_ID, active.id, query, like]);
    return json({ items: values.slice(0, pageSize).map((item) => ({ ...item, enabled: boolean(item.enabled) })),
      page, pageSize, hasMore: values.length > pageSize, total: Number(count?.total ?? 0), requestId }, requestId);
  }
  const values = await rows<Record<string, unknown>>(env, `
    SELECT s.id, f.id AS feedId,
      COALESCE(NULLIF(s.custom_title, ''), f.title) AS title,
      f.url, f.site_url AS siteUrl, COALESCE(s.category, '') AS category,
      s.sort_order AS sortOrder, s.is_active AS enabled,
      CASE f.fetch_status WHEN 'running' THEN 'fetching' WHEN 'succeeded' THEN 'ok' WHEN 'failed' THEN 'error' ELSE 'pending' END AS fetchStatus,
      (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS articleCount,
      s.created_at AS createdAt, s.updated_at AS updatedAt
    FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
    WHERE s.owner_id = ?1 AND (?2 = '' OR COALESCE(NULLIF(s.custom_title, ''), f.title) LIKE ?3 OR f.url LIKE ?3 OR s.category LIKE ?3)
    ORDER BY s.sort_order, lower(COALESCE(NULLIF(s.custom_title, ''), f.title)), s.id
    LIMIT ?4 OFFSET ?5`, [OWNER_ID, query, like, pageSize + 1, offset]);
  const count = await first<{ total: number }>(env, `
    SELECT COUNT(*) AS total FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
    WHERE s.owner_id = ?1 AND (?2 = '' OR COALESCE(NULLIF(s.custom_title, ''), f.title) LIKE ?3 OR f.url LIKE ?3 OR s.category LIKE ?3)`,
  [OWNER_ID, query, like]);
  const hasMore = values.length > pageSize;
  const items = values.slice(0, pageSize).map((item) => ({ ...item, enabled: boolean(item.enabled) }));
  return json({ items, page, pageSize, hasMore, total: Number(count?.total ?? 0), requestId }, requestId);
}

export async function addSubscription(request: Request, env: ClientApiEnv, requestId: string): Promise<Response> {
  const input = await readJsonObject(request);
  const url = normalizeHttpUrl(input.url ?? input.URL);
  const title = stringField(input.title ?? input.Title, "title", 500);
  const category = stringField(input.category ?? input.Category, "category", 200);
  const categoryId = stringField(input.categoryId ?? input.CategoryId, "categoryId", 100);
  let libraryCategoryName = "";
  let resolvedCategoryId = categoryId;
  if (categoryId) {
    const ownedCategory = await first<{ id: string; name: string }>(env,
      `SELECT id, name FROM library_categories WHERE id = ?1 AND owner_id = ?2`, [categoryId, OWNER_ID]);
    if (!ownedCategory) throw new ApiError(400, "invalid_category", "Category does not exist");
    libraryCategoryName = ownedCategory.name;
  } else if (category) {
    const created = now();
    await env.DB.prepare(`INSERT OR IGNORE INTO library_categories(id, owner_id, name, sort_order, created_at, updated_at)
      VALUES (?1, ?2, ?3, COALESCE((SELECT MAX(sort_order) + 1 FROM library_categories WHERE owner_id = ?2), 0), ?4, ?4)`)
      .bind(crypto.randomUUID(), OWNER_ID, category, created).run();
    const legacyCategory = await first<{ id: string; name: string }>(env,
      "SELECT id, name FROM library_categories WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE", [OWNER_ID, category]);
    resolvedCategoryId = legacyCategory?.id ?? "";
    libraryCategoryName = legacyCategory?.name ?? category;
  }
  const active = await activeConnection(env, OWNER_ID);
  if (active.type !== "direct_rss") {
    await createExternalSubscription(env, OWNER_ID, active.id, { url, title, category: libraryCategoryName || category }, requestId);
    return json({ status: "queued", requestId }, requestId, 202);
  }
  const timestamp = now();
  const feedId = crypto.randomUUID();
  const feed = await first<{ id: string }>(env, `
    INSERT INTO feeds (id, owner_id, url, title, fetch_status, next_fetch_at, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5, ?5)
    ON CONFLICT(owner_id, url) DO UPDATE SET updated_at = feeds.updated_at
    RETURNING id`, [feedId, OWNER_ID, url, title, timestamp]);
  if (!feed) throw new ApiError(500, "database_error", "Unable to create feed");
  const subscriptionId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO subscriptions (id, owner_id, feed_id, category, custom_title, is_active, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, NULLIF(?5, ''), 1, ?6, ?6)
    ON CONFLICT(owner_id, feed_id) DO UPDATE SET
      category = excluded.category,
      custom_title = COALESCE(excluded.custom_title, subscriptions.custom_title),
      is_active = 1,
      updated_at = excluded.updated_at`).bind(subscriptionId, OWNER_ID, feed.id, libraryCategoryName || category, title, timestamp).run();
  const ownerId = await requestOwnerId(env);
  const directConnectionId = `connection:direct-rss:${ownerId}`;
  await env.DB.prepare(`INSERT INTO source_connections
    (id, owner_id, connector_type, name, sync_policy, capabilities_json, cursor_json, status, created_at, updated_at)
    VALUES (?1, ?2, 'direct_rss', 'Direct RSS', 'feedmind_primary',
      '{"categories":true,"incrementalCursor":true,"readState":false,"writeState":false}', '{}', 'ok', ?3, ?3)
    ON CONFLICT(id) DO NOTHING`).bind(directConnectionId, OWNER_ID, timestamp).run();
  await env.DB.prepare(`INSERT INTO sources
    (id, owner_id, connection_id, external_id, kind, title, url, enabled, sync_status, legacy_feed_id, metadata_json, library_category_id, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'feed', ?5, ?4, 1, 'pending', ?1, '{}', ?6, ?7, ?7)
    ON CONFLICT(connection_id, external_id) DO UPDATE SET title = COALESCE(NULLIF(excluded.title, ''), sources.title),
      library_category_id = excluded.library_category_id,
      enabled = 1, sync_status = 'pending', updated_at = excluded.updated_at`)
    .bind(feed.id, OWNER_ID, directConnectionId, url, title, resolvedCategoryId || null, timestamp).run();
  if (libraryCategoryName || category) await env.DB.prepare(`INSERT INTO source_categories(source_id, name, sort_order) VALUES (?1, ?2, 0)
    ON CONFLICT(source_id, name) DO NOTHING`).bind(feed.id, libraryCategoryName || category).run();
  await env.FEED_QUEUE.send({ feedId: feed.id, requestId, reason: "subscription_created" }, { contentType: "json" });
  return json({ feedId: feed.id, status: "queued", requestId }, requestId, 202);
}

async function getSubscription(env: ClientApiEnv, id: string, requestId: string): Promise<Response> {
  const active = await activeConnection(env, OWNER_ID);
  if (active.type !== "direct_rss") {
    const item = await first<Record<string, unknown>>(env, `SELECT src.id, src.id AS feedId,
      COALESCE(NULLIF(src.custom_title, ''), src.title) AS title, COALESCE(src.url, '') AS url,
      src.site_url AS siteUrl, COALESCE(category.name, '') AS category, src.library_sort_order AS sortOrder,
      src.enabled, src.sync_status AS fetchStatus, src.created_at AS createdAt, src.updated_at AS updatedAt
      FROM sources src LEFT JOIN library_categories category ON category.id = src.library_category_id
      WHERE src.id = ?1 AND src.owner_id = ?2 AND src.connection_id = ?3 AND src.enabled = 1`, [id, OWNER_ID, active.id]);
    return json({ items: item ? [{ ...item, enabled: boolean(item.enabled) }] : [], requestId }, requestId);
  }
  const item = await first<Record<string, unknown>>(env, `
    SELECT s.id, f.id AS feedId, COALESCE(NULLIF(s.custom_title, ''), f.title) AS title,
      f.url, f.site_url AS siteUrl, COALESCE(s.category, '') AS category,
      s.sort_order AS sortOrder, s.is_active AS enabled,
      CASE f.fetch_status WHEN 'running' THEN 'fetching' WHEN 'succeeded' THEN 'ok' WHEN 'failed' THEN 'error' ELSE 'pending' END AS fetchStatus,
      (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS articleCount,
      s.created_at AS createdAt, s.updated_at AS updatedAt
    FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
    WHERE s.id = ?1 AND s.owner_id = ?2`, [id, OWNER_ID]);
  return json({ items: item ? [{ ...item, enabled: boolean(item.enabled) }] : [], requestId }, requestId);
}

async function patchSubscription(request: Request, env: ClientApiEnv, id: string, requestId: string): Promise<Response> {
  const input = await readJsonObject(request);
  const title = stringField(input.title, "title", 500);
  const category = stringField(input.category, "category", 200);
  const active = await activeConnection(env, OWNER_ID);
  if (active.type !== "direct_rss") {
    await updateExternalSubscription(env, OWNER_ID, active.id, id, { title, category }, requestId);
    return new Response(null, { status: 204 });
  }
  const sortOrder = input.sortOrder ?? 0;
  if (!Number.isSafeInteger(sortOrder) || Number(sortOrder) < 0 || Number(sortOrder) > 1_000_000) {
    throw new ApiError(422, "validation_failed", "sortOrder is invalid");
  }
  if (typeof input.enabled !== "boolean") throw new ApiError(422, "validation_failed", "enabled must be a boolean");
  const result = await env.DB.prepare(`
    UPDATE subscriptions SET custom_title = NULLIF(?1, ''), category = ?2, sort_order = ?3,
      is_active = ?4, updated_at = ?5 WHERE id = ?6 AND owner_id = ?7`)
    .bind(title, category, sortOrder, input.enabled ? 1 : 0, now(), id, OWNER_ID).run();
  if ((result.meta?.changes ?? 0) === 0) throw new ApiError(404, "not_found", "Subscription not found");
  await env.DB.prepare(`UPDATE sources SET enabled = ?1, sync_status = ?2, updated_at = ?3
    WHERE legacy_feed_id = (SELECT feed_id FROM subscriptions WHERE id = ?4 AND owner_id = ?5) AND owner_id = ?5`)
    .bind(input.enabled ? 1 : 0, input.enabled ? "pending" : "disabled", now(), id, OWNER_ID).run();
  await env.DB.prepare(`DELETE FROM source_categories WHERE source_id = (
    SELECT feed_id FROM subscriptions WHERE id = ?1 AND owner_id = ?2)`).bind(id, OWNER_ID).run();
  if (category) await env.DB.prepare(`INSERT INTO source_categories(source_id, name, sort_order)
    SELECT feed_id, ?1, 0 FROM subscriptions WHERE id = ?2 AND owner_id = ?3`).bind(category, id, OWNER_ID).run();
  return new Response(null, { status: 204 });
}

async function deleteSubscription(env: ClientApiEnv, id: string, requestId: string): Promise<Response> {
  const active = await activeConnection(env, OWNER_ID);
  if (active.type !== "direct_rss") {
    await deleteExternalSubscription(env, OWNER_ID, active.id, id, requestId);
    return new Response(null, { status: 204 });
  }
  const subscription = await first<{ feedId: string }>(env, "SELECT feed_id AS feedId FROM subscriptions WHERE id = ?1 AND owner_id = ?2", [id, OWNER_ID]);
  const result = await env.DB.prepare("DELETE FROM subscriptions WHERE id = ?1 AND owner_id = ?2")
    .bind(id, OWNER_ID).run();
  if ((result.meta?.changes ?? 0) === 0) throw new ApiError(404, "not_found", "Subscription not found");
  if (subscription) await env.DB.prepare("UPDATE sources SET enabled = 0, sync_status = 'disabled', updated_at = ?1 WHERE legacy_feed_id = ?2")
    .bind(now(), subscription.feedId).run();
  return new Response(null, { status: 204 });
}

async function refreshSubscription(env: ClientApiEnv, id: string, requestId: string): Promise<Response> {
  const active = await activeConnection(env, OWNER_ID);
  if (active.type !== "direct_rss") {
    const source = await first<{ id: string }>(env, "SELECT id FROM sources WHERE id = ?1 AND owner_id = ?2 AND connection_id = ?3 AND enabled = 1", [id, OWNER_ID, active.id]);
    if (!source) throw new ApiError(404, "not_found", "Subscription not found");
    const selection = await first<{ revision: number }>(env,
      "SELECT revision FROM account_source_selections WHERE owner_id = ?1 AND active_connection_id = ?2", [OWNER_ID, active.id]);
    await env.FEED_QUEUE.send({ connectionId: active.id, sourceId: id, selectionRevision: Number(selection?.revision ?? 0),
      requestId, reason: "manual_refresh" }, { contentType: "json" });
    return json({ status: "queued", requestId }, requestId, 202);
  }
  const subscription = await first<{ feedId: string }>(env,
    "SELECT feed_id AS feedId FROM subscriptions WHERE id = ?1 AND owner_id = ?2 AND is_active = 1", [id, OWNER_ID]);
  if (!subscription) throw new ApiError(404, "not_found", "Subscription not found");
  await env.DB.prepare("UPDATE feeds SET fetch_status = 'pending', last_error_code = NULL, next_fetch_at = ?1, updated_at = ?1 WHERE id = ?2")
    .bind(now(), subscription.feedId).run();
  await env.FEED_QUEUE.send({ feedId: subscription.feedId, requestId, reason: "manual_refresh" }, { contentType: "json" });
  return json({ status: "queued", requestId }, requestId, 202);
}

function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function importOpml(request: Request, env: ClientApiEnv, requestId: string): Promise<Response> {
  const input = await readJsonObject(request); const url = normalizeHttpUrl(input.url); const category = stringField(input.category, "category", 200);
  if (category) {
    const created = now();
    await env.DB.prepare(`INSERT OR IGNORE INTO library_categories(id, owner_id, name, sort_order, created_at, updated_at)
      VALUES (?1, ?2, ?3, COALESCE((SELECT MAX(sort_order) + 1 FROM library_categories WHERE owner_id = ?2), 0), ?4, ?4)`)
      .bind(crypto.randomUUID(), OWNER_ID, category, created).run();
  }
  const libraryCategory = category ? await first<{ id: string }>(env,
    "SELECT id FROM library_categories WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE", [OWNER_ID, category]) : null;
  const ownerId = await requestOwnerId(env); const directConnectionId = `connection:direct-rss:${ownerId}`; const connectionCreated = now();
  await env.DB.prepare(`INSERT INTO source_connections
    (id, owner_id, connector_type, name, sync_policy, capabilities_json, cursor_json, status, created_at, updated_at)
    VALUES (?1, ?2, 'direct_rss', 'Direct RSS', 'feedmind_primary',
      '{"categories":true,"incrementalCursor":true,"readState":false,"writeState":false}', '{}', 'ok', ?3, ?3)
    ON CONFLICT(id) DO NOTHING`).bind(directConnectionId, OWNER_ID, connectionCreated).run();
  let xml: string;
  try { xml = (await fetchContent(url, "feed")).body; }
  catch { throw new ApiError(422, "opml_fetch_failed", "Unable to fetch the OPML document"); }
  const feeds: Array<{ url: string; title: string }> = [];
  for (const tag of xml.match(/<outline\b[^>]*>/gi) ?? []) {
    const attributes: Record<string, string> = {};
    for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/g)) attributes[match[1].toLowerCase()] = decodeXml(match[3]);
    const raw = attributes.xmlurl; if (!raw) continue;
    try { feeds.push({ url: normalizeHttpUrl(raw), title: (attributes.title || attributes.text || raw).slice(0, 500) }); } catch { /* Skip invalid feed URLs. */ }
    if (feeds.length >= 500) break;
  }
  const unique = [...new Map(feeds.map((feed) => [feed.url, feed])).values()]; let imported = 0; let failed = 0;
  for (const feed of unique) {
    try {
      const created = now(); const feedId = crypto.randomUUID(); const subscriptionId = crypto.randomUUID();
      const stored = await env.DB.prepare(`INSERT INTO feeds (id, owner_id, url, title, fetch_status, next_fetch_at, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5, ?5)
        ON CONFLICT(owner_id, url) DO UPDATE SET updated_at = excluded.updated_at RETURNING id`).bind(feedId, OWNER_ID, feed.url, feed.title, created).first<{ id: string }>();
      if (!stored) throw new Error();
      await env.DB.prepare(`INSERT INTO subscriptions (id, owner_id, feed_id, category, custom_title, is_active, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, '', 1, ?5, ?5)
        ON CONFLICT(owner_id, feed_id) DO UPDATE SET category = excluded.category, is_active = 1, updated_at = excluded.updated_at`)
        .bind(subscriptionId, OWNER_ID, stored.id, category, created).run();
      await env.DB.prepare(`INSERT INTO sources
        (id, owner_id, connection_id, external_id, kind, title, url, enabled, sync_status, legacy_feed_id,
         metadata_json, library_category_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, 'feed', ?5, ?4, 1, 'pending', ?1, '{}', ?6, ?7, ?7)
        ON CONFLICT(connection_id, external_id) DO UPDATE SET enabled = 1,
          library_category_id = excluded.library_category_id, sync_status = 'pending', updated_at = excluded.updated_at`)
        .bind(stored.id, OWNER_ID, directConnectionId, feed.url, feed.title, libraryCategory?.id ?? null, created).run();
      await env.FEED_QUEUE.send({ feedId: stored.id, requestId, reason: "subscription_created" }, { contentType: "json" }); imported++;
    } catch { failed++; }
  }
  return json({ total: unique.length, imported, failed, requestId }, requestId, 202);
}

export async function listArticles(request: Request, env: ClientApiEnv, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const { page, pageSize, offset } = pagination(url);
  const scope = url.searchParams.get("scope") ?? "all";
  if (!["all", "recent", "saved"].includes(scope)) throw new ApiError(422, "validation_failed", "scope is invalid");
  const starred = url.searchParams.get("starred") === "true" || scope === "saved";
  const unread = url.searchParams.get("unread") === "true";
  const excludeSelected = url.searchParams.get("excludeSelected") === "true";
  const feedId = (url.searchParams.get("feedId") ?? "").slice(0, 100);
  const categoryId = (url.searchParams.get("categoryId") ?? "").slice(0, 100);
  const category = (url.searchParams.get("category") ?? "").trim().slice(0, 200);
  const query = (url.searchParams.get("query") ?? "").trim().slice(0, 200);
  const tag = (url.searchParams.get("tag") ?? "").trim().slice(0, 64);
  const minimumScoreRaw = url.searchParams.get("minInformationScore");
  const minimumScore = minimumScoreRaw == null || minimumScoreRaw === "" ? -1 : Number.parseInt(minimumScoreRaw, 10);
  if (!Number.isInteger(minimumScore) || minimumScore < -1 || minimumScore > 100) {
    throw new ApiError(422, "validation_failed", "minInformationScore is invalid");
  }
  const requestedLocale = url.searchParams.get("targetLocale") ?? "zh-CN";
  const targetLocale = ["zh-CN", "en-US", "ja-JP"].includes(requestedLocale) ? requestedLocale : "zh-CN";
  const sourceId = (url.searchParams.get("sourceId") ?? "").slice(0, 100);
  const connectionId = (url.searchParams.get("connectionId") ?? "").slice(0, 100);
  const recent = scope === "recent";
  const recentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const values = [OWNER_ID, starred ? 1 : 0, unread ? 1 : 0, feedId, query, `%${query}%`, category, `%${category}%`, tag, minimumScore, sourceId, connectionId, recent ? 1 : 0, recentCutoff, categoryId];
  const where = `a.owner_id = ?1 AND (
      (EXISTS (SELECT 1 FROM account_source_selections sel JOIN source_connections con ON con.id = sel.active_connection_id
        WHERE sel.owner_id = ?1 AND con.connector_type = 'direct_rss')
       AND EXISTS (SELECT 1 FROM subscriptions sx WHERE sx.feed_id = a.feed_id AND sx.owner_id = ?1 AND sx.is_active = 1))
      OR EXISTS (SELECT 1 FROM source_items six JOIN sources ssx ON ssx.id = six.source_id
        JOIN account_source_selections sel ON sel.active_connection_id = six.connection_id AND sel.owner_id = ?1
        WHERE six.article_id = a.id AND six.owner_id = ?1 AND ssx.enabled = 1)
    )
    AND (?2 = 0 OR COALESCE(st.is_saved, 0) = 1)
    AND (?3 = 0 OR COALESCE(st.is_read, 0) = 0)
    AND (?4 = '' OR a.feed_id = ?4 OR EXISTS (SELECT 1 FROM source_items sif WHERE sif.article_id = a.id AND sif.source_id = ?4))
    AND (?5 = '' OR a.title LIKE ?6 OR EXISTS (
      SELECT 1 FROM article_preprocessing_runs pr JOIN article_preprocessing_locales pl ON pl.run_id = pr.id
      WHERE pr.article_id = a.id AND pr.is_current = 1 AND (pl.one_line_summary LIKE ?6 OR pl.key_points_json LIKE ?6)))
    AND (?7 = '' OR (EXISTS (SELECT 1 FROM subscriptions scs WHERE scs.feed_id = a.feed_id AND scs.owner_id = ?1 AND scs.category LIKE ?8)
      AND EXISTS (SELECT 1 FROM account_source_selections sel JOIN source_connections con ON con.id = sel.active_connection_id
        WHERE sel.owner_id = ?1 AND con.connector_type = 'direct_rss'))
      OR EXISTS (SELECT 1 FROM source_items sic JOIN source_categories scc ON scc.source_id = sic.source_id
        JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = sic.connection_id
        WHERE sic.article_id = a.id AND scc.name LIKE ?8))
    AND (?9 = '' OR EXISTS (SELECT 1 FROM article_preprocessing_runs pr
      JOIN article_topic_tags apt ON apt.run_id = pr.id JOIN topic_tags tg ON tg.id = apt.tag_id
      WHERE pr.article_id = a.id AND pr.is_current = 1 AND tg.status = 'active' AND tg.tag_key = ?9))
    AND (?10 < 0 OR EXISTS (SELECT 1 FROM article_preprocessing_runs pr
      JOIN article_information_scores sc ON sc.run_id = pr.id
      WHERE pr.article_id = a.id AND pr.is_current = 1 AND sc.total_score >= ?10))
    AND (?11 = '' OR EXISTS (SELECT 1 FROM source_items sis JOIN account_source_selections sel
      ON sel.owner_id = ?1 AND sel.active_connection_id = sis.connection_id WHERE sis.article_id = a.id AND sis.source_id = ?11))
    AND (?12 = '' OR EXISTS (SELECT 1 FROM source_items sicn WHERE sicn.article_id = a.id AND sicn.connection_id = ?12))
    AND (?13 = 0 OR st.last_opened_at >= ?14)
    AND (?15 = '' OR EXISTS (SELECT 1 FROM source_items slc JOIN sources sls ON sls.id = slc.source_id
      JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = slc.connection_id
      WHERE slc.article_id = a.id AND sls.owner_id = ?1 AND sls.enabled = 1
        AND ((?15 = 'uncategorized' AND sls.library_category_id IS NULL) OR sls.library_category_id = ?15)))
    ${excludeSelected ? `AND NOT EXISTS (SELECT 1 FROM feeds selected_feed
      WHERE selected_feed.id = a.feed_id AND selected_feed.owner_id = ?1
        AND selected_feed.url = 'feedmind://selected/owner')` : ""}`;
  const items = await rows<Record<string, unknown>>(env, `
    SELECT a.id,
      CASE WHEN (SELECT connection.connector_type FROM account_source_selections selection JOIN source_connections connection
        ON connection.id = selection.active_connection_id WHERE selection.owner_id = ?1) = 'direct_rss' THEN a.feed_id
        ELSE (SELECT si.source_id FROM source_items si JOIN account_source_selections selection
          ON selection.owner_id = ?1 AND selection.active_connection_id = si.connection_id
          WHERE si.article_id = a.id ORDER BY si.first_seen_at LIMIT 1) END AS feedId,
      CASE WHEN (SELECT connection.connector_type FROM account_source_selections selection JOIN source_connections connection
        ON connection.id = selection.active_connection_id WHERE selection.owner_id = ?1) = 'direct_rss'
        THEN (SELECT COALESCE(NULLIF(sx.custom_title, ''), fx.title) FROM subscriptions sx JOIN feeds fx ON fx.id = sx.feed_id
          WHERE sx.feed_id = a.feed_id AND sx.owner_id = ?1 LIMIT 1)
        ELSE (SELECT COALESCE(NULLIF(src.custom_title, ''), src.title) FROM source_items si JOIN sources src ON src.id = si.source_id
          JOIN account_source_selections selection ON selection.owner_id = ?1 AND selection.active_connection_id = si.connection_id
          WHERE si.article_id = a.id ORDER BY si.first_seen_at LIMIT 1) END AS feedTitle,
      CASE WHEN EXISTS (SELECT 1 FROM feeds selected_feed WHERE selected_feed.id = a.feed_id
        AND selected_feed.owner_id = ?1 AND selected_feed.url = 'feedmind://selected/owner') THEN 1 ELSE 0 END AS isSelected,
      a.title,
      (SELECT tt.translated_title FROM article_classifications c
        JOIN article_title_translations tt ON tt.classification_id = c.id
        WHERE c.article_id = a.id AND c.source_hash = a.source_hash AND tt.target_locale = ?16
        ORDER BY c.created_at DESC LIMIT 1) AS translatedTitle,
      (SELECT c.source_title_locale FROM article_classifications c
        WHERE c.article_id = a.id AND c.source_hash = a.source_hash
        ORDER BY c.created_at DESC LIMIT 1) AS sourceTitleLocale,
      ?16 AS translatedTitleLocale,
      (SELECT pl.one_line_summary FROM article_preprocessing_runs pr
        JOIN article_preprocessing_locales pl ON pl.run_id = pr.id
        WHERE pr.article_id = a.id AND pr.is_current = 1 AND pl.target_locale = ?16 LIMIT 1) AS oneLineSummary,
      (SELECT sc.total_score FROM article_preprocessing_runs pr JOIN article_information_scores sc ON sc.run_id = pr.id
        WHERE pr.article_id = a.id AND pr.is_current = 1 LIMIT 1) AS informationScore,
      CASE WHEN EXISTS (SELECT 1 FROM article_preprocessing_runs pr WHERE pr.article_id = a.id AND pr.is_current = 1)
        THEN 'completed' ELSE COALESCE((SELECT CASE WHEN pt.error_code = 'content_too_large'
          THEN 'content_too_large' ELSE pt.status END FROM article_preprocessing_tasks pt
          WHERE pt.article_id = a.id ORDER BY pt.created_at DESC LIMIT 1), 'missing') END AS preprocessingStatus,
      (SELECT json_group_array(json_object('key', tx.tag_key, 'name',
          COALESCE(json_extract(tx.names_json, '$."' || ?16 || '"'), tx.tag_key))) FROM (
        SELECT tg.tag_key, tg.names_json FROM article_preprocessing_runs pr
        JOIN article_topic_tags apt ON apt.run_id = pr.id JOIN topic_tags tg ON tg.id = apt.tag_id
        WHERE pr.article_id = a.id AND pr.is_current = 1 AND tg.status = 'active' ORDER BY apt.rank LIMIT 3
      ) tx) AS topicTagsJson,
      a.canonical_url AS url, a.author, a.published_at AS publishedAt,
      a.thumbnail_url AS thumbnailUrl, a.source_hash AS contentHash, a.parser_version AS parserVersion,
      COALESCE(st.is_read, 0) AS isRead, COALESCE(st.is_saved, 0) AS isStarred,
      COALESCE(st.reading_progress, 0) AS progress, st.last_opened_at AS lastOpenedAt,
      CASE a.parse_status WHEN 'completed' THEN 'ok' WHEN 'failed' THEN 'error' ELSE a.parse_status END AS parseStatus,
      a.parse_error AS parseError,
      (SELECT json_group_array(json_object('id', src.id, 'connectionId', src.connection_id, 'kind', src.kind,
        'title', src.title, 'url', src.url)) FROM source_items si JOIN sources src ON src.id = si.source_id
        JOIN account_source_selections selection ON selection.owner_id = ?1 AND selection.active_connection_id = si.connection_id
        WHERE si.article_id = a.id) AS sourcesJson,
      a.created_at AS createdAt, a.updated_at AS updatedAt
    FROM articles a LEFT JOIN article_states st ON st.article_id = a.id AND st.owner_id = ?1
      AND st.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?1)
    WHERE ${where}
    ORDER BY CASE WHEN ?13 = 1 THEN st.last_opened_at END DESC, a.published_at DESC, a.id DESC
    LIMIT ?17 OFFSET ?18`, [...values, targetLocale, pageSize + 1, offset]);
  const count = await first<{ total: number }>(env, `
    SELECT COUNT(*) AS total FROM articles a
      LEFT JOIN article_states st ON st.article_id = a.id AND st.owner_id = ?1
        AND st.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?1)
    WHERE ${where}`, values);
  const hasMore = items.length > pageSize;
  const mapped = items.slice(0, pageSize).map((item) => ({
    ...item,
    topicTags: JSON.parse(String(item.topicTagsJson ?? "[]")),
    topicTagsJson: undefined,
    sources: JSON.parse(String(item.sourcesJson ?? "[]")),
    sourcesJson: undefined,
    isRead: boolean(item.isRead),
    isStarred: boolean(item.isStarred),
    isSelected: boolean(item.isSelected),
    contentHtml: "",
    contentText: "",
  }));
  return json({ items: mapped, page, pageSize, hasMore, total: Number(count?.total ?? 0), requestId }, requestId);
}

async function postReadingActivity(request: Request, env: ClientApiEnv, id: string, requestId: string): Promise<Response> {
  const input = await readJsonObject(request);
  const operationId = stringField(input.operationId, "operationId", 128, true);
  stringField(input.sessionId, "sessionId", 128, true);
  const kind = stringField(input.kind, "kind", 16, true);
  if (kind !== "engaged" && kind !== "progress") throw new ApiError(422, "validation_failed", "kind is invalid");
  if (typeof input.progress !== "number" || !Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1) {
    throw new ApiError(422, "validation_failed", "progress is invalid");
  }
  const active = await activeConnection(env, OWNER_ID);
  const article = await first<{ id: string }>(env, `SELECT a.id FROM articles a WHERE a.id = ?1 AND a.owner_id = ?2 AND (
    (?3 LIKE 'connection:direct-rss:%' AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?2 AND s.is_active = 1))
    OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
      WHERE si.article_id = a.id AND si.owner_id = ?2 AND si.connection_id = ?3 AND src.enabled = 1))`, [id, OWNER_ID, active.id]);
  if (!article) throw new ApiError(404, "not_found", "Article not found");
  const existing = await first<{ articleId: string }>(env,
    "SELECT article_id AS articleId FROM article_state_operations WHERE owner_id = ?1 AND connection_id = ?2 AND operation_id = ?3",
  [OWNER_ID, active.id, operationId]);
  if (existing && existing.articleId !== id) throw new ApiError(409, "idempotency_key_conflict", "operationId was used for another article");
  if (!existing) {
    const timestamp = now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO article_state_operations(owner_id, operation_id, article_id, created_at, connection_id) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(OWNER_ID, operationId, id, timestamp, active.id),
      env.DB.prepare(`INSERT INTO article_states
        (owner_id, connection_id, article_id, is_read, is_saved, reading_progress, read_at, saved_at, updated_at, last_opened_at)
        VALUES (?1, ?2, ?3, ?4, 0, ?5, CASE WHEN ?4 = 1 THEN ?6 END, NULL, ?6, CASE WHEN ?4 = 1 THEN ?6 END)
        ON CONFLICT(owner_id, connection_id, article_id) DO UPDATE SET
          is_read = CASE WHEN ?4 = 1 THEN 1 ELSE article_states.is_read END,
          reading_progress = excluded.reading_progress,
          read_at = CASE WHEN ?4 = 1 THEN COALESCE(article_states.read_at, ?6) ELSE article_states.read_at END,
          last_opened_at = CASE WHEN ?4 = 1 THEN ?6 ELSE article_states.last_opened_at END,
          updated_at = ?6`).bind(OWNER_ID, active.id, id, kind === "engaged" ? 1 : 0, input.progress, timestamp),
    ]);
    if (kind === "engaged") {
      const remoteItems = await rows<{ sourceItemId: string; connectionId: string }>(env, `SELECT si.id AS sourceItemId,
        si.connection_id AS connectionId FROM source_items si JOIN source_connections c ON c.id = si.connection_id
        WHERE si.article_id = ?1 AND si.owner_id = ?2 AND si.connection_id = ?3 AND c.sync_policy <> 'feedmind_primary'
          AND json_extract(c.capabilities_json, '$.writeState') = 1`, [id, OWNER_ID, active.id]);
      if (remoteItems.length) {
        const state = await first<{ isStarred: number }>(env,
          "SELECT is_saved AS isStarred FROM article_states WHERE owner_id = ?1 AND connection_id = ?2 AND article_id = ?3", [OWNER_ID, active.id, id]);
        await env.DB.batch(remoteItems.flatMap((item) => [
          env.DB.prepare(`UPDATE state_sync_outbox SET status = 'completed', last_error_code = 'superseded', updated_at = ?1
            WHERE source_item_id = ?2 AND status IN ('pending', 'failed')`).bind(timestamp, item.sourceItemId),
          env.DB.prepare(`INSERT INTO state_sync_outbox
            (id, owner_id, connection_id, source_item_id, desired_read, desired_saved, status, attempt_count,
             next_attempt_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, 'pending', 0, ?6, ?6, ?6)`)
            .bind(crypto.randomUUID(), OWNER_ID, item.connectionId, item.sourceItemId, state?.isStarred ? 1 : 0, timestamp),
        ]));
        await Promise.all([...new Set(remoteItems.map((item) => item.connectionId))].map((connectionId) =>
          env.FEED_QUEUE.send({ connectionId, requestId, reason: "state_changed" }, { contentType: "json" }))).catch(() => undefined);
      }
    }
  }
  const state = await first<Record<string, unknown>>(env, `SELECT article_id AS articleId, is_read AS isRead,
    is_saved AS isStarred, reading_progress AS progress, last_opened_at AS lastOpenedAt, updated_at AS updatedAt
    FROM article_states WHERE owner_id = ?1 AND connection_id = ?2 AND article_id = ?3`, [OWNER_ID, active.id, id]);
  return json({ data: state ? { ...state, isRead: boolean(state.isRead), isStarred: boolean(state.isStarred) } : null, requestId }, requestId);
}

export async function addArticle(request: Request, env: ClientApiEnv, requestId: string): Promise<Response> {
  const active = await activeConnection(env, OWNER_ID);
  if (active.type !== "direct_rss") throw new ApiError(409, "active_source_unsupported", "Single articles can only be added to the current system source");
  const input = await readJsonObject(request);
  const url = normalizeHttpUrl(input.url ?? input.URL);
  const title = stringField(input.title ?? input.Title, "title", 500) || url;
  const existing = await first<{ id: string; feedId: string; parseStatus: string }>(env, `
    SELECT a.id, a.feed_id AS feedId, a.parse_status AS parseStatus FROM articles a
      JOIN subscriptions s ON s.feed_id = a.feed_id
    WHERE a.owner_id = ?1 AND a.canonical_url = ?2 AND s.owner_id = ?1`, [OWNER_ID, url]);
  if (existing) return json({ articleId: existing.id, feedId: existing.feedId, status: existing.parseStatus, requestId }, requestId);

  const timestamp = now();
  let selected = await first<{ id: string }>(env, "SELECT id FROM feeds WHERE owner_id = ?1 AND url = ?2", [OWNER_ID, "feedmind://selected/owner"]);
  if (!selected) {
    const id = crypto.randomUUID();
    selected = await first<{ id: string }>(env, `
      INSERT INTO feeds (id, owner_id, url, title, fetch_status, created_at, updated_at)
      VALUES (?1, ?2, ?3, '自选', 'succeeded', ?4, ?4)
      ON CONFLICT(owner_id, url) DO UPDATE SET updated_at = feeds.updated_at RETURNING id`,
    [id, OWNER_ID, "feedmind://selected/owner", timestamp]);
  }
  if (!selected) throw new ApiError(500, "database_error", "Unable to create selected feed");
  await env.DB.prepare(`
    INSERT INTO subscriptions (id, owner_id, feed_id, category, custom_title, is_active, created_at, updated_at)
    VALUES (?1, ?2, ?3, '', '自选', 1, ?4, ?4)
    ON CONFLICT(owner_id, feed_id) DO UPDATE SET is_active = 1, updated_at = excluded.updated_at`)
    .bind(crypto.randomUUID(), OWNER_ID, selected.id, timestamp).run();

  const selectedSource = await first<{ id: string }>(env, `
    INSERT INTO sources
      (id, owner_id, connection_id, external_id, kind, title, url, enabled, sync_status,
       legacy_feed_id, metadata_json, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'feed', '自选', ?4, 1, 'ok', ?1, '{"system":"selected"}', ?5, ?5)
    ON CONFLICT(connection_id, external_id) DO UPDATE SET
      title = '自选', enabled = 1, sync_status = 'ok', legacy_feed_id = excluded.legacy_feed_id,
      metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
    RETURNING id`, [selected.id, OWNER_ID, active.id, "feedmind://selected/owner", timestamp]);
  if (!selectedSource) throw new ApiError(500, "database_error", "Unable to create selected source");

  const articleId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO articles (id, owner_id, feed_id, canonical_url, title, published_at, parse_status, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?6, ?6)`)
      .bind(articleId, OWNER_ID, selected.id, url, title, timestamp),
    env.DB.prepare(`
      INSERT INTO source_items
        (id, owner_id, connection_id, source_id, external_item_id, article_id, canonical_url,
         metadata_json, first_seen_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, '{}', ?7, ?7)`)
      .bind(`selected:${articleId}`, OWNER_ID, active.id, selectedSource.id, articleId, url, timestamp),
    env.DB.prepare(`
      INSERT INTO article_parse_tasks (id, article_id, source_url, status, requested_by, request_id, created_at)
      VALUES (?1, ?2, ?3, 'pending', 'system', ?4, ?5)`)
      .bind(crypto.randomUUID(), articleId, url, requestId, timestamp),
  ]);
  await env.ARTICLE_QUEUE.send({ articleId, requestId, reason: "article_created" }, { contentType: "json" });
  return json({ articleId, feedId: selected.id, status: "queued", requestId }, requestId, 202);
}

async function deleteSelectedArticle(env: ClientApiEnv, id: string): Promise<Response> {
  const selected = await first<{ id: string }>(env, `SELECT article.id
    FROM articles article JOIN feeds feed ON feed.id = article.feed_id AND feed.owner_id = article.owner_id
    WHERE article.id = ?1 AND article.owner_id = ?2 AND feed.url = 'feedmind://selected/owner'`, [id, OWNER_ID]);
  if (!selected) throw new ApiError(404, "selected_article_not_found", "Selected article not found");
  const result = await env.DB.prepare("DELETE FROM articles WHERE id = ?1 AND owner_id = ?2")
    .bind(id, OWNER_ID).run();
  if ((result.meta?.changes ?? 0) === 0) throw new ApiError(404, "selected_article_not_found", "Selected article not found");
  return new Response(null, { status: 204 });
}

interface ArticleDetailRow extends Record<string, unknown> {
  sourceHtmlKey?: string | null;
  sourceTextKey?: string | null;
}

async function articleDetail(env: ClientApiEnv, id: string, targetLocale = "zh-CN"): Promise<ArticleDetailRow | null> {
  return first<ArticleDetailRow>(env, `
    SELECT a.id,
      CASE WHEN (SELECT con.connector_type FROM account_source_selections sel JOIN source_connections con ON con.id = sel.active_connection_id WHERE sel.owner_id = ?1) = 'direct_rss'
        THEN a.feed_id ELSE (SELECT si.source_id FROM source_items si JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = si.connection_id WHERE si.article_id = a.id LIMIT 1) END AS feedId,
      CASE WHEN (SELECT con.connector_type FROM account_source_selections sel JOIN source_connections con ON con.id = sel.active_connection_id WHERE sel.owner_id = ?1) = 'direct_rss'
        THEN s.id ELSE (SELECT si.source_id FROM source_items si JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = si.connection_id WHERE si.article_id = a.id LIMIT 1) END AS feedRecordId,
      CASE WHEN (SELECT con.connector_type FROM account_source_selections sel JOIN source_connections con ON con.id = sel.active_connection_id WHERE sel.owner_id = ?1) = 'direct_rss'
        THEN COALESCE(NULLIF(s.custom_title, ''), f.title) ELSE (SELECT COALESCE(NULLIF(src.custom_title, ''), src.title) FROM source_items si JOIN sources src ON src.id = si.source_id JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = si.connection_id WHERE si.article_id = a.id LIMIT 1) END AS feedTitle,
      CASE WHEN f.url = 'feedmind://selected/owner' THEN 1 ELSE 0 END AS isSelected,
      CASE WHEN (SELECT con.connector_type FROM account_source_selections sel JOIN source_connections con ON con.id = sel.active_connection_id WHERE sel.owner_id = ?1) = 'direct_rss'
        THEN s.category ELSE (SELECT group_concat(sc.name, ', ') FROM source_items si JOIN source_categories sc ON sc.source_id = si.source_id JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = si.connection_id WHERE si.article_id = a.id) END AS feedCategory,
      CASE WHEN (SELECT con.connector_type FROM account_source_selections sel JOIN source_connections con ON con.id = sel.active_connection_id WHERE sel.owner_id = ?1) = 'direct_rss'
        THEN f.site_url ELSE (SELECT src.site_url FROM source_items si JOIN sources src ON src.id = si.source_id JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = si.connection_id WHERE si.article_id = a.id LIMIT 1) END AS feedSiteUrl,
      CASE WHEN (SELECT con.connector_type FROM account_source_selections sel JOIN source_connections con ON con.id = sel.active_connection_id WHERE sel.owner_id = ?1) = 'direct_rss'
        THEN f.url ELSE (SELECT src.url FROM source_items si JOIN sources src ON src.id = si.source_id JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = si.connection_id WHERE si.article_id = a.id LIMIT 1) END AS feedUrl, a.title,
      (SELECT tt.translated_title FROM article_classifications c
        JOIN article_title_translations tt ON tt.classification_id = c.id
        WHERE c.article_id = a.id AND c.source_hash = a.source_hash AND tt.target_locale = ?3
        ORDER BY c.created_at DESC LIMIT 1) AS translatedTitle,
      (SELECT c.source_title_locale FROM article_classifications c
        WHERE c.article_id = a.id AND c.source_hash = a.source_hash
        ORDER BY c.created_at DESC LIMIT 1) AS sourceTitleLocale,
      ?3 AS translatedTitleLocale,
      (SELECT pl.one_line_summary FROM article_preprocessing_runs pr
        JOIN article_preprocessing_locales pl ON pl.run_id = pr.id
        WHERE pr.article_id = a.id AND pr.is_current = 1 AND pl.target_locale = ?3 LIMIT 1) AS oneLineSummary,
      (SELECT pl.key_points_json FROM article_preprocessing_runs pr
        JOIN article_preprocessing_locales pl ON pl.run_id = pr.id
        WHERE pr.article_id = a.id AND pr.is_current = 1 AND pl.target_locale = ?3 LIMIT 1) AS keyPointsJson,
      (SELECT sc.total_score FROM article_preprocessing_runs pr JOIN article_information_scores sc ON sc.run_id = pr.id
        WHERE pr.article_id = a.id AND pr.is_current = 1 LIMIT 1) AS informationScore,
      (SELECT sc.dimensions_json FROM article_preprocessing_runs pr JOIN article_information_scores sc ON sc.run_id = pr.id
        WHERE pr.article_id = a.id AND pr.is_current = 1 LIMIT 1) AS informationScoreDimensionsJson,
      (SELECT sc.reason FROM article_preprocessing_runs pr JOIN article_information_scores sc ON sc.run_id = pr.id
        WHERE pr.article_id = a.id AND pr.is_current = 1 LIMIT 1) AS informationScoreReason,
      CASE WHEN EXISTS (SELECT 1 FROM article_preprocessing_runs pr WHERE pr.article_id = a.id AND pr.is_current = 1)
        THEN 'completed' ELSE COALESCE((SELECT CASE WHEN pt.error_code = 'content_too_large'
          THEN 'content_too_large' ELSE pt.status END FROM article_preprocessing_tasks pt
          WHERE pt.article_id = a.id ORDER BY pt.created_at DESC LIMIT 1), 'missing') END AS preprocessingStatus,
      (SELECT json_group_array(json_object('key', tx.tag_key, 'name',
          COALESCE(json_extract(tx.names_json, '$."' || ?3 || '"'), tx.tag_key))) FROM (
        SELECT tg.tag_key, tg.names_json FROM article_preprocessing_runs pr
        JOIN article_topic_tags apt ON apt.run_id = pr.id JOIN topic_tags tg ON tg.id = apt.tag_id
        WHERE pr.article_id = a.id AND pr.is_current = 1 AND tg.status = 'active' ORDER BY apt.rank
      ) tx) AS topicTagsJson,
      a.canonical_url AS url,
      a.author, a.published_at AS publishedAt, a.thumbnail_url AS thumbnailUrl,
      a.source_hash AS contentHash, a.parser_version AS parserVersion,
      CASE a.parse_status WHEN 'completed' THEN 'ok' WHEN 'failed' THEN 'error' ELSE a.parse_status END AS parseStatus,
      a.parse_error AS parseError, a.source_html_key AS sourceHtmlKey, a.source_text_key AS sourceTextKey,
      (SELECT json_group_array(json_object('id', src.id, 'connectionId', src.connection_id, 'kind', src.kind,
        'title', src.title, 'url', src.url)) FROM source_items si JOIN sources src ON src.id = si.source_id
        JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = si.connection_id
        WHERE si.article_id = a.id) AS sourcesJson,
      COALESCE(st.is_read, 0) AS isRead, COALESCE(st.is_saved, 0) AS isStarred,
      COALESCE(st.reading_progress, 0) AS progress, a.created_at AS createdAt, a.updated_at AS updatedAt
    FROM articles a LEFT JOIN feeds f ON f.id = a.feed_id LEFT JOIN subscriptions s ON s.feed_id = f.id AND s.owner_id = ?1
      LEFT JOIN article_states st ON st.article_id = a.id AND st.owner_id = ?1
        AND st.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?1)
    WHERE a.id = ?2 AND a.owner_id = ?1 AND ((s.is_active = 1 AND EXISTS (
      SELECT 1 FROM account_source_selections sel JOIN source_connections con ON con.id = sel.active_connection_id
      WHERE sel.owner_id = ?1 AND con.connector_type = 'direct_rss')) OR EXISTS (
      SELECT 1 FROM source_items six JOIN sources srcx ON srcx.id = six.source_id
      JOIN account_source_selections sel ON sel.active_connection_id = six.connection_id AND sel.owner_id = ?1
      WHERE six.article_id = a.id AND six.owner_id = ?1 AND srcx.enabled = 1))`, [OWNER_ID, id, targetLocale]);
}

export async function getArticle(env: ClientApiEnv, id: string, requestId: string, request?: Request): Promise<Response> {
  const requestedLocale = request ? new URL(request.url).searchParams.get("targetLocale") ?? "zh-CN" : "zh-CN";
  const targetLocale = ["zh-CN", "en-US", "ja-JP"].includes(requestedLocale) ? requestedLocale : "zh-CN";
  const item = await articleDetail(env, id, targetLocale);
  if (!item) return json({ items: [], requestId }, requestId);
  const { sourceHtmlKey, sourceTextKey, ...publicItem } = item;
  return json({ items: [{
    ...publicItem,
    keyPoints: JSON.parse(String(publicItem.keyPointsJson ?? "[]")),
    keyPointsJson: undefined,
    informationScoreDimensions: publicItem.informationScoreDimensionsJson
      ? JSON.parse(String(publicItem.informationScoreDimensionsJson)) : null,
    informationScoreDimensionsJson: undefined,
    topicTags: JSON.parse(String(publicItem.topicTagsJson ?? "[]")),
    topicTagsJson: undefined,
    sources: JSON.parse(String(publicItem.sourcesJson ?? "[]")),
    sourcesJson: undefined,
    isRead: boolean(publicItem.isRead),
    isStarred: boolean(publicItem.isStarred),
    isSelected: boolean(publicItem.isSelected),
    contentHtml: "",
    contentText: "",
    contentAvailable: Boolean(sourceHtmlKey || sourceTextKey),
  }], requestId }, requestId);
}

export async function getArticleContent(request: Request, env: ClientApiEnv, id: string, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "html";
  if (format !== "html" && format !== "text") throw new ApiError(422, "validation_failed", "format must be html or text");
  const article = await articleDetail(env, id);
  if (!article) throw new ApiError(404, "not_found", "Article not found");
  const key = article.sourceHtmlKey;
  if (typeof key !== "string" || !key) throw new ApiError(404, "content_not_available", "Article content is not available");
  const object = await env.CONTENT.get(key);
  if (!object) throw new ApiError(404, "content_not_available", "Article content object is missing");
  const { cursor, limit } = contentWindow(url);
  const contentHtml = annotateAndHideContentBlocks(await object.text());
  const filteredContent = format === "html" ? contentHtml : contentHtmlToText(contentHtml);
  const window = sliceCodePoints(filteredContent, cursor, limit);
  return json({
    data: {
      articleId: id,
      format,
      content: window.content,
      cursor,
      nextCursor: window.nextCursor,
      totalCharacters: window.totalCharacters,
      contentHash: article.contentHash ?? null,
      mimeType: format === "html" ? "text/html" : "text/plain",
    },
    requestId,
  }, requestId);
}

async function putArticleState(request: Request, env: ClientApiEnv, id: string, requestId: string): Promise<Response> {
  const input = await readJsonObject(request);
  if (typeof input.isRead !== "boolean" || typeof input.isStarred !== "boolean" ||
      typeof input.progress !== "number" || !Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1) {
    throw new ApiError(422, "validation_failed", "Article state is invalid");
  }
  const operationId = stringField(input.operationId ?? input.operationID, "operationId", 128, true);
  const active = await activeConnection(env, OWNER_ID);
  const article = await first<{ id: string }>(env, `
    SELECT a.id FROM articles a
    WHERE a.id = ?1 AND a.owner_id = ?2 AND (
      (?3 LIKE 'connection:direct-rss:%' AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?2 AND s.is_active = 1))
      OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
        WHERE si.article_id = a.id AND si.owner_id = ?2 AND si.connection_id = ?3 AND src.enabled = 1)
    )`, [id, OWNER_ID, active.id]);
  if (!article) throw new ApiError(404, "not_found", "Article not found");
  const existingOperation = await first<{ articleId: string }>(env,
    "SELECT article_id AS articleId FROM article_state_operations WHERE owner_id = ?1 AND connection_id = ?2 AND operation_id = ?3",
  [OWNER_ID, active.id, operationId]);
  if (existingOperation && existingOperation.articleId !== id) {
    throw new ApiError(409, "idempotency_key_conflict", "operationId was used for another article");
  }
  if (existingOperation) return new Response(null, { status: 204 });
  const timestamp = now();
  const remoteItems = await rows<{ sourceItemId: string; connectionId: string }>(env, `SELECT si.id AS sourceItemId,
    si.connection_id AS connectionId FROM source_items si JOIN source_connections c ON c.id = si.connection_id
    WHERE si.article_id = ?1 AND si.owner_id = ?2 AND si.connection_id = ?3 AND c.sync_policy <> 'feedmind_primary'
      AND json_extract(c.capabilities_json, '$.writeState') = 1`, [id, OWNER_ID, active.id]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO article_state_operations (owner_id, operation_id, article_id, created_at, connection_id)
      VALUES (?1, ?2, ?3, ?4, ?5)`).bind(OWNER_ID, operationId, id, timestamp, active.id),
    env.DB.prepare(`INSERT INTO article_states
      (owner_id, connection_id, article_id, is_read, is_saved, reading_progress, read_at, saved_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?4 = 1 THEN ?7 END, CASE WHEN ?5 = 1 THEN ?7 END, ?7)
      ON CONFLICT(owner_id, connection_id, article_id) DO UPDATE SET
        is_read = excluded.is_read, is_saved = excluded.is_saved, reading_progress = excluded.reading_progress,
        read_at = CASE WHEN excluded.is_read = 1 THEN excluded.updated_at ELSE article_states.read_at END,
        saved_at = CASE WHEN excluded.is_saved = 1 THEN excluded.updated_at ELSE article_states.saved_at END,
        updated_at = excluded.updated_at`).bind(OWNER_ID, active.id, id, input.isRead ? 1 : 0, input.isStarred ? 1 : 0, input.progress, timestamp),
    ...remoteItems.flatMap((item) => [
      env.DB.prepare(`UPDATE state_sync_outbox SET status = 'completed', last_error_code = 'superseded', updated_at = ?1
        WHERE source_item_id = ?2 AND status IN ('pending', 'failed')`).bind(timestamp, item.sourceItemId),
      env.DB.prepare(`INSERT INTO state_sync_outbox
        (id, owner_id, connection_id, source_item_id, desired_read, desired_saved, status, attempt_count,
         next_attempt_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, ?7, ?7, ?7)`)
        .bind(crypto.randomUUID(), OWNER_ID, item.connectionId, item.sourceItemId, input.isRead ? 1 : 0,
          input.isStarred ? 1 : 0, timestamp),
    ]),
  ]);
  const connectionIds = [...new Set(remoteItems.map((item) => item.connectionId))];
  await Promise.all(connectionIds.map((connectionId) => env.FEED_QUEUE.send(
    { connectionId, requestId, reason: "state_changed" }, { contentType: "json" },
  ))).catch(() => undefined);
  return new Response(null, { status: 204 });
}

interface TranslationRow extends Record<string, unknown> {
  id: string;
  status: string;
  retryCount: number;
  resultKey: string | null;
  contentHtmlKey: string | null;
  createdAt: string;
  sourceHash: string;
}

interface StoredAlignment {
  mapping: Array<{ fromStableId: string; toStableId: string }>;
  currentCoverage: number;
  ambiguous: boolean;
}

async function sourceAlignment(env: ClientApiEnv, articleId: string, fromSourceHash: string, toSourceHash: string): Promise<StoredAlignment> {
  if (fromSourceHash === toSourceHash) return { mapping: [], currentCoverage: 1, ambiguous: false };
  const cached = await first<{ mappingJson: string; currentCoverage: number; isAmbiguous: number }>(env, `SELECT
    mapping_json AS mappingJson, current_coverage AS currentCoverage, is_ambiguous AS isAmbiguous
    FROM article_source_block_alignments WHERE article_id = ?1 AND from_source_hash = ?2 AND to_source_hash = ?3`,
  [articleId, fromSourceHash, toSourceHash]);
  if (cached) return { mapping: JSON.parse(cached.mappingJson), currentCoverage: Number(cached.currentCoverage), ambiguous: Boolean(cached.isAmbiguous) };
  const load = (sourceHash: string) => rows<AlignableContentBlock>(env, `SELECT stable_id AS stableId,
    block_kind AS kind, exact_fingerprint AS exactFingerprint, normalized_length AS normalizedLength
    FROM article_content_blocks WHERE article_id = ?1 AND source_hash = ?2 ORDER BY block_index`, [articleId, sourceHash]);
  const [from, to] = await Promise.all([load(fromSourceHash), load(toSourceHash)]);
  const aligned = alignContentBlocks(from, to);
  await env.DB.prepare(`INSERT OR REPLACE INTO article_source_block_alignments
    (article_id, from_source_hash, to_source_hash, mapping_json, current_coverage, is_ambiguous, algorithm_version, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ordered-exact-lcs-v1', ?7)`)
    .bind(articleId, fromSourceHash, toSourceHash, JSON.stringify(aligned.mapping), aligned.currentCoverage,
      aligned.ambiguous ? 1 : 0, now()).run();
  return aligned;
}

const reusableAlignment = (alignment: StoredAlignment) => !alignment.ambiguous && alignment.currentCoverage >= 0.8;

async function translationRows(env: ClientApiEnv, articleId: string, targetLocale: string): Promise<TranslationRow[]> {
  return rows<TranslationRow>(env, `SELECT id, article_id AS articleId, target_locale AS targetLocale,
    article_type AS articleType, status, source_hash AS sourceHash, translated_title AS translatedTitle,
    result_key AS resultKey, content_html_key AS contentHtmlKey, retry_count AS retryCount,
    workflow_instance_id AS workflowInstanceId, created_at AS createdAt, started_at AS startedAt,
    completed_at AS completedAt
    FROM translations WHERE owner_id = ?1 AND article_id = ?2 AND target_locale = ?3
    ORDER BY created_at DESC`, [OWNER_ID, articleId, targetLocale]);
}

export async function listTranslations(request: Request, env: ClientApiEnv, articleId: string, requestId: string): Promise<Response> {
  const targetLocale = (new URL(request.url).searchParams.get("targetLocale") ?? "zh-CN").slice(0, 35);
  const article = await first<{ id: string }>(env, `SELECT a.id FROM articles a
    WHERE a.id = ?1 AND a.owner_id = ?2 AND (
      (EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?2 AND s.is_active = 1)
       AND EXISTS (SELECT 1 FROM account_source_selections selection JOIN source_connections connection ON connection.id = selection.active_connection_id
         WHERE selection.owner_id = ?2 AND connection.connector_type = 'direct_rss'))
      OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
        WHERE si.article_id = a.id AND si.owner_id = ?2 AND src.enabled = 1
          AND si.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?2)))`, [articleId, OWNER_ID]);
  if (!article) throw new ApiError(404, "not_found", "Article not found");
  return json({ items: await translationRows(env, articleId, targetLocale), requestId }, requestId);
}

export async function getTranslation(env: ClientApiEnv, translationId: string, requestId: string): Promise<Response> {
  const data = await first<TranslationRow>(env, `SELECT t.id, t.article_id AS articleId,
    t.target_locale AS targetLocale, t.article_type AS articleType, t.status, t.source_hash AS sourceHash,
    t.translated_title AS translatedTitle, t.retry_count AS retryCount,
    t.workflow_instance_id AS workflowInstanceId, t.created_at AS createdAt,
    t.started_at AS startedAt, t.completed_at AS completedAt
    FROM translations t
    JOIN articles a ON a.id = t.article_id
    WHERE t.id = ?1 AND t.owner_id = ?2 AND (
      (EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?2 AND s.is_active = 1)
       AND EXISTS (SELECT 1 FROM account_source_selections selection JOIN source_connections connection ON connection.id = selection.active_connection_id
         WHERE selection.owner_id = ?2 AND connection.connector_type = 'direct_rss'))
      OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
        WHERE si.article_id = a.id AND si.owner_id = ?2 AND src.enabled = 1
          AND si.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?2)))`, [translationId, OWNER_ID]);
  if (!data) throw new ApiError(404, "not_found", "Translation not found");
  return json({ data, pollAfterSeconds: ["pending", "running", "cancel_requested"].includes(data.status) ? 3 : 0, requestId }, requestId);
}

export async function retryTranslation(
  request: Request,
  env: ClientApiEnv,
  translationId: string,
  requestId: string,
  surface: "client" | "gpt_action" = "client",
): Promise<Response> {
  const requestHash = await digest(JSON.stringify({ translationId, operation: "retry" }));
  const replay = await idempotentResponse(request, env, requestHash, surface);
  if (replay) return replay;
  const translation = await first<TranslationRow & { articleId: string; targetLocale: string }>(env, `SELECT t.id,
    t.article_id AS articleId, t.target_locale AS targetLocale, t.article_type AS articleType,
    t.status, t.source_hash AS sourceHash, t.translated_title AS translatedTitle,
    t.retry_count AS retryCount, t.workflow_instance_id AS workflowInstanceId,
    t.created_at AS createdAt, t.started_at AS startedAt, t.completed_at AS completedAt
    FROM translations t
    JOIN articles a ON a.id = t.article_id
    WHERE t.id = ?1 AND t.owner_id = ?2 AND (
      (EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?2 AND s.is_active = 1)
       AND EXISTS (SELECT 1 FROM account_source_selections selection JOIN source_connections connection ON connection.id = selection.active_connection_id
         WHERE selection.owner_id = ?2 AND connection.connector_type = 'direct_rss'))
      OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
        WHERE si.article_id = a.id AND si.owner_id = ?2 AND src.enabled = 1
          AND si.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?2)))`, [translationId, OWNER_ID]);
  if (!translation) throw new ApiError(404, "not_found", "Translation not found");
  if (!["failed", "cancelled", "superseded"].includes(translation.status)) {
    throw new ApiError(409, "translation_not_retryable", "Translation is not in a retryable state");
  }
  const limits = await first<{ valueJson: string }>(env, `SELECT value_json AS valueJson FROM system_config_versions
    WHERE config_key = 'translation_limits' AND status = 'active'`);
  const maximum = Number(JSON.parse(limits?.valueJson ?? "{}").maxRetries ?? 3);
  if (translation.retryCount >= maximum) {
    throw new ApiError(409, "retry_limit_reached", "Translation retry limit has been reached");
  }
  const lastAttempt = await first<{ attempt: number; completedAt: string | null }>(env, `SELECT attempt,
    completed_at AS completedAt FROM translation_attempts WHERE translation_id = ?1
    ORDER BY attempt DESC LIMIT 1`, [translationId]);
  const delay = 30 * 2 ** Math.min(translation.retryCount, 8);
  if (lastAttempt?.completedAt && Date.now() < Date.parse(lastAttempt.completedAt) + delay * 1000) {
    throw new ApiError(409, "translation_retry_backoff", "Translation retry backoff has not elapsed");
  }
  const attempt = Number(lastAttempt?.attempt ?? 0) + 1;
  const attemptId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE translations SET status = 'pending', retry_count = retry_count + 1,
        workflow_instance_id = NULL, started_at = NULL, completed_at = NULL
        WHERE id = ?1 AND status IN ('failed','cancelled','superseded')`).bind(translationId),
      env.DB.prepare(`INSERT INTO translation_attempts
        (id, translation_id, attempt, status, created_at) VALUES (?1, ?2, ?3, 'pending', ?4)`)
        .bind(attemptId, translationId, attempt, now()),
    ]);
  } catch {
    throw new ApiError(409, "translation_concurrent_change", "Translation state changed concurrently; retry the request");
  }
  const instance = await env.BODY_TRANSLATION_WORKFLOW.create({
    id: `translation-${translationId}-attempt-${attempt}`,
    params: { translationId, attemptId, requestId },
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE translations SET workflow_instance_id = ?1 WHERE id = ?2").bind(instance.id, translationId),
    env.DB.prepare("UPDATE translation_attempts SET workflow_instance_id = ?1 WHERE id = ?2").bind(instance.id, attemptId),
  ]);
  const data = {
    ...translation,
    status: "pending",
    retryCount: translation.retryCount + 1,
    workflowInstanceId: instance.id,
    startedAt: null,
    completedAt: null,
  };
  const payload = { data, reused: false, pollAfterSeconds: 3, requestId };
  await storeIdempotentResponse(request, env, requestHash, 202, payload, surface);
  return json(payload, requestId, 202);
}

export async function startTranslation(
  request: Request,
  env: ClientApiEnv,
  articleId: string,
  requestId: string,
  surface: "client" | "gpt_action" = "client",
): Promise<Response> {
  const input = await readJsonObject(request);
  const targetLocale = stringField(input.targetLocale ?? "zh-CN", "targetLocale", 35, true);
  const requestHash = await digest(JSON.stringify({ articleId, targetLocale }));
  const replay = await idempotentResponse(request, env, requestHash, surface);
  if (replay) return replay;
  const existing = await translationRows(env, articleId, targetLocale);
  const articleVersion = await first<{ sourceHash: string }>(env, `SELECT source_hash AS sourceHash FROM articles
    WHERE id = ?1 AND owner_id = ?2 AND parse_status = 'completed'`, [articleId, OWNER_ID]);
  const currentSourceHash = articleVersion?.sourceHash ?? '';
  let completed = existing.find((item) => item.status === "completed" && item.sourceHash === currentSourceHash);
  if (!completed && currentSourceHash) {
    for (const candidate of existing.filter((item) => item.status === "completed")) {
      if (reusableAlignment(await sourceAlignment(env, articleId, candidate.sourceHash, currentSourceHash))) {
        completed = candidate;
        break;
      }
    }
  }
  if (completed) {
    const payload = { data: completed, reused: true, pollAfterSeconds: 0, requestId };
    await storeIdempotentResponse(request, env, requestHash, 200, payload, surface);
    return json(payload, requestId);
  }
  const active = existing.find((item) => item.sourceHash === currentSourceHash && ["pending", "running", "cancel_requested"].includes(item.status));
  if (active) {
    const payload = { data: active, reused: true, pollAfterSeconds: 3, requestId };
    await storeIdempotentResponse(request, env, requestHash, 202, payload, surface);
    return json(payload, requestId, 202);
  }

  let translationId: string;
  let attemptNumber: number;
  let attemptId = crypto.randomUUID();
  let concurrentWinner: TranslationRow | undefined;
  const terminal = existing.find((item) => ["failed", "cancelled", "superseded"].includes(item.status));
  if (terminal) {
    const limits = await first<{ valueJson: string }>(env, `SELECT value_json AS valueJson FROM system_config_versions
      WHERE config_key = 'translation_limits' AND status = 'active'`);
    const maximum = Number(JSON.parse(limits?.valueJson ?? "{}").maxRetries ?? 3);
    if (terminal.retryCount >= maximum) throw new ApiError(409, "retry_limit_reached", "Translation retry limit has been reached");
    const lastAttempt = await first<{ attempt: number; completedAt: string | null }>(env, `SELECT attempt, completed_at AS completedAt
      FROM translation_attempts WHERE translation_id = ?1 ORDER BY attempt DESC LIMIT 1`, [terminal.id]);
    const delay = 30 * 2 ** Math.min(terminal.retryCount, 8);
    if (lastAttempt?.completedAt && Date.now() < Date.parse(lastAttempt.completedAt) + delay * 1000) {
      throw new ApiError(409, "translation_retry_backoff", "Translation retry backoff has not elapsed");
    }
    translationId = terminal.id;
    attemptNumber = Number(lastAttempt?.attempt ?? 0) + 1;
    try {
      await env.DB.batch([
        env.DB.prepare(`UPDATE translations SET status = 'pending', retry_count = retry_count + 1,
          workflow_instance_id = NULL, started_at = NULL, completed_at = NULL WHERE id = ?1 AND status IN ('failed','cancelled','superseded')`).bind(translationId),
        env.DB.prepare(`INSERT INTO translation_attempts
          (id, translation_id, attempt, status, created_at) VALUES (?1, ?2, ?3, 'pending', ?4)`)
          .bind(attemptId, translationId, attemptNumber, now()),
      ]);
    } catch {
      concurrentWinner = (await translationRows(env, articleId, targetLocale))
        .find((item) => item.status === 'completed' || ['pending','running','cancel_requested'].includes(item.status));
      if (!concurrentWinner) throw new ApiError(409, "translation_concurrent_change", "Translation state changed concurrently; retry the request");
    }
  } else {
    const classifiedArticle = await first<{
      sourceHash: string; articleType: string; translatedTitle: string; titleProfileVersionId: string;
    }>(env, `SELECT a.source_hash AS sourceHash, c.article_type AS articleType,
      COALESCE(tt.translated_title, c.translated_title, a.title) AS translatedTitle,
      c.title_profile_version_id AS titleProfileVersionId
      FROM articles a
      JOIN article_classifications c ON c.article_id = a.id AND c.source_hash = a.source_hash AND c.is_current = 1
      LEFT JOIN article_title_translations tt ON tt.classification_id = c.id AND tt.target_locale = ?2
      WHERE a.id = ?1 AND a.owner_id = ?3 AND a.parse_status = 'completed' AND (
        (EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?3 AND s.is_active = 1)
         AND EXISTS (SELECT 1 FROM account_source_selections selection JOIN source_connections connection ON connection.id = selection.active_connection_id
           WHERE selection.owner_id = ?3 AND connection.connector_type = 'direct_rss'))
        OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
          WHERE si.article_id = a.id AND si.owner_id = ?3 AND src.enabled = 1
            AND si.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?3)))`, [articleId, targetLocale, OWNER_ID]);
    if (!classifiedArticle) {
      throw new ApiError(409, "article_classification_unavailable", "Article must be classified before translation");
    }
    const translationConfig = await first<{ promptVersionId: string; bodyProfileVersionId: string }>(env,
      `SELECT p.id AS promptVersionId, q.id AS bodyProfileVersionId
      FROM prompt_definitions d
      JOIN prompt_versions p ON p.id = d.current_version_id AND p.status = 'active'
      JOIN ai_profile_versions q ON q.profile = 'quality' AND q.provider = 'openrouter' AND q.status = 'active'
      WHERE d.task = 'body_translation' AND d.article_type = ?1
        AND d.target_locale = ?2 AND d.deleted_at IS NULL`, [classifiedArticle.articleType, targetLocale]);
    if (!translationConfig) {
      throw new ApiError(409, "translation_configuration_unavailable",
        `No active translation prompt is configured for ${classifiedArticle.articleType}`);
    }
    const context = { ...classifiedArticle, ...translationConfig };
    translationId = crypto.randomUUID();
    attemptNumber = 1;
    const created = now();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO translations
        (id, owner_id, article_id, target_locale, article_type, status, source_hash, translated_title,
         prompt_version_id, title_profile_version_id, body_profile_version_id, trigger_reason,
         retry_count, created_by, request_id, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, ?10,
            ?11, 0, ?12, ?13, ?14)`)
          .bind(translationId, OWNER_ID, articleId, targetLocale, context.articleType, context.sourceHash,
            context.translatedTitle, context.promptVersionId, context.titleProfileVersionId,
            context.bodyProfileVersionId,
            surface === 'gpt_action' ? 'first_gpt_action_request' : 'first_client_request',
            surface, requestId, created),
        env.DB.prepare(`INSERT INTO translation_attempts
          (id, translation_id, attempt, status, created_at) VALUES (?1, ?2, 1, 'pending', ?3)`)
          .bind(attemptId, translationId, created),
      ]);
    } catch {
      concurrentWinner = (await translationRows(env, articleId, targetLocale))
        .find((item) => item.status === 'completed' || ['pending','running','cancel_requested'].includes(item.status));
      if (!concurrentWinner) throw new ApiError(409, "translation_concurrent_change", "Translation state changed concurrently; retry the request");
    }
  }
  if (concurrentWinner) {
    const status = concurrentWinner.status === 'completed' ? 200 : 202;
    const payload = { data: concurrentWinner, reused: true, pollAfterSeconds: status === 200 ? 0 : 3, requestId };
    await storeIdempotentResponse(request, env, requestHash, status, payload, surface);
    return json(payload, requestId, status);
  }
  const workflowId = `translation-${translationId}-attempt-${attemptNumber}`;
  const instance = await env.BODY_TRANSLATION_WORKFLOW.create({
    id: workflowId,
    params: { translationId, attemptId, requestId },
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE translations SET workflow_instance_id = ?1 WHERE id = ?2").bind(instance.id, translationId),
    env.DB.prepare("UPDATE translation_attempts SET workflow_instance_id = ?1 WHERE id = ?2").bind(instance.id, attemptId),
  ]);
  const data = await first<TranslationRow>(env, `SELECT id, article_id AS articleId, target_locale AS targetLocale,
    article_type AS articleType, status, source_hash AS sourceHash, translated_title AS translatedTitle,
    retry_count AS retryCount, workflow_instance_id AS workflowInstanceId, created_at AS createdAt
    FROM translations WHERE id = ?1`, [translationId]);
  const payload = { data, reused: false, pollAfterSeconds: 3, requestId };
  await storeIdempotentResponse(request, env, requestHash, 202, payload, surface);
  return json(payload, requestId, 202);
}

export async function getTranslationContent(request: Request, env: ClientApiEnv, translationId: string, requestId: string): Promise<Response> {
  const translation = await first<{ articleId: string; status: string; contentHtmlKey: string | null; resultKey: string | null;
    sourceHash: string; currentSourceHash: string }>(env, `
    SELECT t.article_id AS articleId, t.status, t.content_html_key AS contentHtmlKey, t.result_key AS resultKey,
      t.source_hash AS sourceHash, a.source_hash AS currentSourceHash
    FROM translations t JOIN articles a ON a.id = t.article_id
    WHERE t.id = ?1 AND t.owner_id = ?2 AND (
      (EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?2 AND s.is_active = 1)
       AND EXISTS (SELECT 1 FROM account_source_selections selection JOIN source_connections connection ON connection.id = selection.active_connection_id
         WHERE selection.owner_id = ?2 AND connection.connector_type = 'direct_rss'))
      OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
        WHERE si.article_id = a.id AND si.owner_id = ?2 AND src.enabled = 1
          AND si.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?2)))`, [translationId, OWNER_ID]);
  if (!translation) throw new ApiError(404, "not_found", "Translation not found");
  if (translation.status !== "completed") {
    const batches = await rows<{ batchIndex: number; partialKey: string }>(env, `SELECT
      b.batch_index AS batchIndex, b.partial_key AS partialKey
      FROM translation_batches b
      JOIN translation_attempts attempt ON attempt.id = b.attempt_id
      WHERE attempt.translation_id = ?1 AND attempt.attempt = (
        SELECT MAX(latest.attempt) FROM translation_attempts latest WHERE latest.translation_id = ?1
      ) AND b.status = 'completed' AND b.partial_key IS NOT NULL
      ORDER BY b.batch_index`, [translationId]);
    const partials = await Promise.all(batches.map(async (batch) => {
      const object = await env.CONTENT.get(batch.partialKey);
      if (!object) return [];
      try {
        const value = JSON.parse(await object.text()) as { blocks?: unknown };
        if (!Array.isArray(value.blocks)) return [];
        return value.blocks.filter((block): block is [string, string] =>
          Array.isArray(block) && block.length === 2
          && typeof block[0] === "string" && typeof block[1] === "string");
      } catch {
        return [];
      }
    }));
    return json({ data: {
      translationId, articleId: translation.articleId, format: "partial_blocks", content: "",
      partialBlocks: partials.flat(), completedBatches: batches.length,
      cursor: 0, nextCursor: null, totalCharacters: 0,
    }, requestId }, requestId);
  }
  if (!translation.contentHtmlKey) throw new ApiError(404, "content_not_available", "Translation content object is missing");
  const object = await env.CONTENT.get(translation.contentHtmlKey);
  if (!object) throw new ApiError(404, "content_not_available", "Translation content object is missing");
  const url = new URL(request.url);
  const { cursor, limit } = contentWindow(url);
  const hidden = new Set<string>();
  if (translation.sourceHash !== translation.currentSourceHash) {
    const alignment = await sourceAlignment(env, translation.articleId, translation.sourceHash, translation.currentSourceHash);
    if (!reusableAlignment(alignment)) throw new ApiError(409, "translation_source_stale", "Historical translation cannot be safely aligned with the current article");
    const mappedFrom = new Set(alignment.mapping.map((item) => item.fromStableId));
    const oldBlocks = await rows<{ stableId: string }>(env, `SELECT stable_id AS stableId FROM article_content_blocks
      WHERE article_id = ?1 AND source_hash = ?2`, [translation.articleId, translation.sourceHash]);
    oldBlocks.forEach((block) => { if (!mappedFrom.has(block.stableId)) hidden.add(block.stableId); });
  }
  const filtered = annotateAndHideContentBlocks(await object.text(), hidden);
  const window = sliceCodePoints(filtered, cursor, limit);
  return json({ data: {
    translationId, articleId: translation.articleId, format: "html", content: window.content,
    cursor, nextCursor: window.nextCursor, totalCharacters: window.totalCharacters,
  }, requestId }, requestId);
}

async function thinkingCoachInvoke(request: Request, env: ClientApiEnv, requestId: string): Promise<Response> {
  const input = await readJsonObject(request, 150_000);
  const system = stringField(input.system, "system", 30_000, true);
  const content = stringField(input.content, "content", 100_000, true);
  const profile = await first<{ id: string; provider: string; model: string }>(env,
    "SELECT id, provider, model FROM ai_profile_versions WHERE profile = 'quality' AND provider = 'openrouter' AND status = 'active'");
  if (!profile) throw new ApiError(503, "ai_profile_unavailable", "Active quality AI profile is not configured");
  const response = await env.AI_SERVICE.fetch("https://feedmind-ai-service.internal/invoke", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile: "quality", system, messages: [{ role: "user", content }], json: true }),
  });
  if (!response.ok) throw new ApiError(502, "ai_provider_failed", "Thinking coach AI request failed");
  const result = await response.json() as { data?: { text?: unknown; usage?: Record<string, unknown>; latencyMs?: unknown } };
  if (typeof result.data?.text !== 'string') throw new ApiError(502, "ai_response_invalid", "Thinking coach AI response is invalid");
  const usage = result.data.usage ?? {};
  await env.DB.prepare(`INSERT INTO ai_usage_events
    (id, purpose, profile_version_id, provider, model, status, input_tokens, output_tokens,
     thinking_tokens, latency_ms, request_id, created_at)
    VALUES (?1, 'thinking_coach', ?2, ?3, ?4, 'completed', ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(crypto.randomUUID(), profile.id, profile.provider, profile.model, Number(usage.inputTokens ?? 0),
      Number(usage.outputTokens ?? 0), Number(usage.thinkingTokens ?? 0), Number(result.data.latencyMs ?? 0), requestId, now()).run();
  return json({ data: { text: result.data.text }, requestId }, requestId);
}

export async function routeClientApi(
  request: Request,
  env: ClientApiEnv,
  requestId: string,
  identity: AccessIdentity,
  resolvedAccountId?: string,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const sources = await routeSources(request, env, requestId, identity, resolvedAccountId);
  if (sources) return sources;
  if (/\/reparse$/.test(url.pathname)) return undefined;
  const requestOwnerId = resolvedAccountId ?? await ensureAccount(env.DB, identity);
  env = { ...env, DB: scopedDatabase(env.DB, requestOwnerId) };
  if (url.pathname === "/oauth/authorize" && request.method === "GET") {
    return authorizeGptAction(request, env, requestOwnerId);
  }
  const library = await routeLibrary(request, env, requestId);
  if (library) return library;
  const clientState = await routeClientState(request, env, requestId);
  if (clientState) return clientState;
  if (url.pathname === "/v1/thinking/coach-invoke" && request.method === "POST") return thinkingCoachInvoke(request, env, requestId);
  if (url.pathname === "/v1/opml/import" && request.method === "POST") return importOpml(request, env, requestId);
  if (url.pathname === "/v1/subscriptions") {
    if (request.method === "GET") return listSubscriptions(request, env, requestId);
    if (request.method === "POST") return addSubscription(request, env, requestId);
  }
  const subscription = subscriptionPath(url.pathname);
  if (subscription) {
    if (!subscription.action && request.method === "GET") return getSubscription(env, subscription.id, requestId);
    if (!subscription.action && request.method === "PATCH") return patchSubscription(request, env, subscription.id, requestId);
    if (!subscription.action && request.method === "DELETE") return deleteSubscription(env, subscription.id, requestId);
    if ((subscription.action === "refresh" || subscription.action === "refresh-title") && request.method === "POST") return refreshSubscription(env, subscription.id, requestId);
  }
  if (url.pathname === "/v1/articles") {
    if (request.method === "GET") return listArticles(request, env, requestId);
    if (request.method === "POST") return addArticle(request, env, requestId);
  }
  const articleTranslations = url.pathname.match(/^\/v1\/articles\/([^/]+)\/translations$/);
  if (articleTranslations) {
    const id = decodeURIComponent(articleTranslations[1]);
    if (request.method === "GET") return listTranslations(request, env, id, requestId);
    if (request.method === "POST") return startTranslation(request, env, id, requestId);
  }
  const readingActivity = url.pathname.match(/^\/v1\/articles\/([^/]+)\/reading-activity$/);
  if (readingActivity && request.method === "POST") {
    return postReadingActivity(request, env, decodeURIComponent(readingActivity[1]), requestId);
  }
  const translation = url.pathname.match(/^\/v1\/translations\/([^/]+)(?:\/(content|result|retry))?$/);
  if (translation) {
    const id = decodeURIComponent(translation[1]);
    if (!translation[2] && request.method === "GET") return getTranslation(env, id, requestId);
    if ((translation[2] === "content" || translation[2] === "result") && request.method === "GET") {
      return getTranslationContent(request, env, id, requestId);
    }
    if (translation[2] === "retry" && request.method === "POST") return retryTranslation(request, env, id, requestId);
  }
  const article = articlePath(url.pathname);
  if (article) {
    if (!article.action && request.method === "GET") return getArticle(env, article.id, requestId, request);
    if (!article.action && request.method === "DELETE") return deleteSelectedArticle(env, article.id);
    if (article.action === "content" && request.method === "GET") return getArticleContent(request, env, article.id, requestId);
    if (article.action === "state" && request.method === "PUT") return putArticleState(request, env, article.id, requestId);
  }
  return undefined;
}
