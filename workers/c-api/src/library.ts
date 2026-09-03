import type { D1Database, D1PreparedStatement } from "../../shared/src/cloudflare";
import { ApiError, json } from "../../shared/src/http";
import { REQUEST_OWNER } from "../../shared/src/scoped-db";
import { normalizeHttpUrl, pagination, readJsonObject, stringField } from "./validation";
import { activeConnection, deleteExternalSubscription, updateExternalSubscription, type SourcesEnv } from "./sources";

const OWNER_ID = REQUEST_OWNER;
const now = () => new Date().toISOString();

export interface LibraryEnv extends SourcesEnv {}

async function all<T>(db: D1Database, sql: string, values: unknown[] = []): Promise<T[]> {
  const result = await db.prepare(sql).bind(...values).all<T>();
  return result.results ?? [];
}

async function one<T>(db: D1Database, sql: string, values: unknown[] = []): Promise<T | null> {
  return db.prepare(sql).bind(...values).first<T>();
}

const bool = (value: unknown) => value === true || value === 1;

type TreeFeedRow = Record<string, unknown> & { categoryId: string | null };

async function tree(env: LibraryEnv, requestId: string): Promise<Response> {
  const categories = await all<Record<string, unknown>>(env.DB, `
    SELECT id, name, sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt
    FROM library_categories category
    WHERE category.owner_id = ?1 ORDER BY sort_order, lower(name), id`, [OWNER_ID]);
  const feeds = await all<TreeFeedRow>(env.DB, `
    SELECT s.id, s.library_category_id AS categoryId,
      COALESCE(NULLIF(s.custom_title, ''), s.title, s.url, '') AS title,
      s.url, s.site_url AS siteUrl, s.enabled, s.sync_status AS syncStatus,
      s.last_error_code AS lastErrorCode, s.library_sort_order AS sortOrder,
      c.connector_type AS connectorType,
      (SELECT sub.id FROM subscriptions sub
        WHERE sub.owner_id = ?1 AND sub.feed_id = s.legacy_feed_id LIMIT 1) AS subscriptionId,
      COUNT(DISTINCT si.article_id) AS articleCount,
      COUNT(DISTINCT CASE WHEN COALESCE(ast.is_read, 0) = 0 THEN si.article_id END) AS unreadCount
    FROM sources s
    JOIN source_connections c ON c.id = s.connection_id AND c.owner_id = ?1
    JOIN account_source_selections selection ON selection.owner_id = ?1 AND selection.active_connection_id = s.connection_id
    LEFT JOIN source_items si ON si.source_id = s.id AND si.owner_id = ?1
    LEFT JOIN article_states ast ON ast.article_id = si.article_id AND ast.owner_id = ?1 AND ast.connection_id = s.connection_id
    WHERE s.owner_id = ?1 AND s.enabled = 1
    GROUP BY s.id
    ORDER BY s.library_sort_order, lower(COALESCE(NULLIF(s.custom_title, ''), s.title, s.url, '')), s.id
    LIMIT 1000`, [OWNER_ID]);
  const categoryUnreadRows = await all<{ categoryId: string | null; unreadCount: number }>(env.DB, `
    SELECT s.library_category_id AS categoryId, COUNT(DISTINCT si.article_id) AS unreadCount
    FROM sources s
    JOIN account_source_selections selection ON selection.owner_id = ?1 AND selection.active_connection_id = s.connection_id
    JOIN source_items si ON si.source_id = s.id AND si.owner_id = ?1
    LEFT JOIN article_states ast ON ast.article_id = si.article_id AND ast.owner_id = ?1 AND ast.connection_id = si.connection_id
    WHERE s.owner_id = ?1 AND s.enabled = 1 AND COALESCE(ast.is_read, 0) = 0
    GROUP BY s.library_category_id`, [OWNER_ID]);
  const categoryUnread = new Map(categoryUnreadRows.map((item) => [item.categoryId, Number(item.unreadCount)]));
  const grouped = new Map<string | null, Array<Record<string, unknown>>>();
  for (const feed of feeds) {
    const key = feed.categoryId ?? null;
    const item = { ...feed, enabled: bool(feed.enabled), editableUrl: feed.connectorType === "direct_rss"
      && /^https?:\/\//i.test(String(feed.url ?? "")) };
    const items = grouped.get(key) ?? [];
    items.push(item);
    grouped.set(key, items);
  }
  const nodes = categories.map((category) => {
    const items = grouped.get(String(category.id)) ?? [];
    return { ...category, unreadCount: categoryUnread.get(String(category.id)) ?? 0, feeds: items };
  });
  const uncategorized = grouped.get(null) ?? [];
  const globalUnread = await one<{ count: number }>(env.DB, `
    SELECT COUNT(DISTINCT si.article_id) AS count
    FROM source_items si JOIN sources s ON s.id = si.source_id AND s.owner_id = ?1 AND s.enabled = 1
    JOIN account_source_selections selection ON selection.owner_id = ?1 AND selection.active_connection_id = si.connection_id
    LEFT JOIN article_states ast ON ast.article_id = si.article_id AND ast.owner_id = ?1 AND ast.connection_id = si.connection_id
    WHERE si.owner_id = ?1 AND COALESCE(ast.is_read, 0) = 0`, [OWNER_ID]);
  return json({ data: {
    unreadCount: Number(globalUnread?.count ?? 0),
    categories: nodes,
    uncategorized: { id: null, unreadCount: categoryUnread.get(null) ?? 0, feeds: uncategorized },
  }, requestId }, requestId);
}

export async function createCategory(request: Request, env: LibraryEnv, requestId: string): Promise<Response> {
  const input = await readJsonObject(request);
  const name = stringField(input.name, "name", 200, true).trim();
  const created = now();
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO library_categories(id, owner_id, name, sort_order, created_at, updated_at)
      VALUES (?1, ?2, ?3, COALESCE((SELECT MAX(sort_order) + 1 FROM library_categories WHERE owner_id = ?2), 0), ?4, ?4)`)
      .bind(id, OWNER_ID, name, created).run();
  } catch {
    throw new ApiError(409, "category_exists", "A category with this name already exists");
  }
  const stored = await one<{ sortOrder: number }>(env.DB,
    "SELECT sort_order AS sortOrder FROM library_categories WHERE id = ?1 AND owner_id = ?2", [id, OWNER_ID]);
  return json({ data: { id, name, sortOrder: Number(stored?.sortOrder ?? 0), createdAt: created, updatedAt: created }, requestId }, requestId, 201);
}

async function patchCategory(request: Request, env: LibraryEnv, id: string): Promise<Response> {
  const input = await readJsonObject(request);
  const current = await one<{ id: string; name: string; sortOrder: number }>(env.DB,
    "SELECT id, name, sort_order AS sortOrder FROM library_categories WHERE id = ?1 AND owner_id = ?2", [id, OWNER_ID]);
  if (!current) throw new ApiError(404, "not_found", "Category not found");
  const name = input.name === undefined ? current.name : stringField(input.name, "name", 200, true).trim();
  const sortOrder = input.sortOrder === undefined ? Number(current.sortOrder) : Number(input.sortOrder);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) {
    throw new ApiError(422, "validation_failed", "sortOrder is invalid");
  }
  const conflict = await one<{ id: string }>(env.DB,
    "SELECT id FROM library_categories WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3", [OWNER_ID, name, id]);
  if (conflict) throw new ApiError(409, "category_exists", "A category with this name already exists");
  if (name !== current.name) {
    const active = await activeConnection(env, OWNER_ID);
    const sources = await all<{ id: string; title: string; legacyFeedId: string | null }>(env.DB, `SELECT source.id,
      COALESCE(NULLIF(source.custom_title, ''), source.title, '') AS title, source.legacy_feed_id AS legacyFeedId
      FROM sources source WHERE source.owner_id = ?1 AND source.connection_id = ?2
        AND source.enabled = 1 AND source.library_category_id = ?3`, [OWNER_ID, active.id, id]);
    if (active.type !== "direct_rss") {
      for (const source of sources) await updateExternalSubscription(env, OWNER_ID, active.id, source.id,
        { title: source.title, category: name, preserveOtherCategories: true, removeCategories: [current.name] }, crypto.randomUUID());
    } else {
      await env.DB.batch([
        ...sources.filter((source) => source.legacyFeedId).map((source) => env.DB.prepare(
          "UPDATE subscriptions SET category = ?1, updated_at = ?2 WHERE owner_id = ?3 AND feed_id = ?4")
          .bind(name, now(), OWNER_ID, source.legacyFeedId)),
        env.DB.prepare(`UPDATE source_categories SET name = ?1 WHERE source_id IN
          (SELECT source.id FROM sources source WHERE source.owner_id = ?2 AND source.connection_id = ?3
            AND source.library_category_id = ?4) AND name = ?5`).bind(name, OWNER_ID, active.id, id, current.name),
      ]);
    }
  }
  try {
    const updated = now();
    await env.DB.batch([
      env.DB.prepare("UPDATE library_categories SET name = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4 AND owner_id = ?5")
        .bind(name, sortOrder, updated, id, OWNER_ID),
      env.DB.prepare(`UPDATE subscriptions SET category = ?1, updated_at = ?2 WHERE owner_id = ?3 AND feed_id IN
        (SELECT legacy_feed_id FROM sources WHERE owner_id = ?3 AND library_category_id = ?4 AND legacy_feed_id IS NOT NULL)`)
        .bind(name, updated, OWNER_ID, id),
    ]);
  } catch {
    throw new ApiError(409, "category_exists", "A category with this name already exists");
  }
  return new Response(null, { status: 204 });
}

async function deleteCategory(env: LibraryEnv, id: string): Promise<Response> {
  const category = await one<{ id: string; name: string }>(env.DB,
    "SELECT id, name FROM library_categories WHERE id = ?1 AND owner_id = ?2", [id, OWNER_ID]);
  if (!category) throw new ApiError(404, "not_found", "Category not found");
  const active = await activeConnection(env, OWNER_ID);
  const sources = await all<{ id: string; title: string; legacyFeedId: string | null }>(env.DB, `SELECT source.id,
    COALESCE(NULLIF(source.custom_title, ''), source.title, '') AS title, source.legacy_feed_id AS legacyFeedId
    FROM sources source WHERE source.owner_id = ?1 AND source.connection_id = ?2
      AND source.enabled = 1 AND source.library_category_id = ?3`, [OWNER_ID, active.id, id]);
  if (active.type !== "direct_rss") {
    for (const source of sources) await updateExternalSubscription(env, OWNER_ID, active.id, source.id,
      { title: source.title, category: "", preserveOtherCategories: true, removeCategories: [category.name] }, crypto.randomUUID());
  }
  await env.DB.batch([
    ...sources.filter((source) => source.legacyFeedId).map((source) => env.DB.prepare(
      "UPDATE subscriptions SET category = '', updated_at = ?1 WHERE owner_id = ?2 AND feed_id = ?3")
      .bind(now(), OWNER_ID, source.legacyFeedId)),
    env.DB.prepare(`DELETE FROM source_categories WHERE source_id IN
      (SELECT source.id FROM sources source WHERE source.owner_id = ?1 AND source.connection_id = ?2
        AND source.library_category_id = ?3) AND name = ?4`).bind(OWNER_ID, active.id, id, category.name),
    env.DB.prepare(`UPDATE subscriptions SET category = '', updated_at = ?1 WHERE owner_id = ?2 AND feed_id IN
      (SELECT legacy_feed_id FROM sources WHERE owner_id = ?2 AND library_category_id = ?3 AND legacy_feed_id IS NOT NULL)`)
      .bind(now(), OWNER_ID, id),
    env.DB.prepare("UPDATE sources SET library_category_id = NULL, updated_at = ?1 WHERE owner_id = ?2 AND library_category_id = ?3")
      .bind(now(), OWNER_ID, id),
    env.DB.prepare("DELETE FROM library_categories WHERE id = ?1 AND owner_id = ?2").bind(id, OWNER_ID),
  ]);
  return new Response(null, { status: 204 });
}

async function patchFeed(request: Request, env: LibraryEnv, id: string): Promise<Response> {
  const input = await readJsonObject(request);
  const source = await one<{ id: string; connectorType: string; legacyFeedId: string | null; title: string; enabled: number; categoryId: string | null; sortOrder: number }>(env.DB, `
    SELECT s.id, c.connector_type AS connectorType, s.legacy_feed_id AS legacyFeedId,
      COALESCE(NULLIF(s.custom_title, ''), s.title) AS title, s.enabled,
      s.library_category_id AS categoryId, s.library_sort_order AS sortOrder
    FROM sources s JOIN source_connections c ON c.id = s.connection_id
    JOIN account_source_selections selection ON selection.owner_id = s.owner_id AND selection.active_connection_id = s.connection_id
    WHERE s.id = ?1 AND s.owner_id = ?2`, [id, OWNER_ID]);
  if (!source) throw new ApiError(404, "not_found", "Feed not found");
  const title = input.customTitle === undefined ? source.title : stringField(input.customTitle, "customTitle", 500).trim();
  const enabled = input.enabled === undefined ? bool(source.enabled) : input.enabled;
  if (typeof enabled !== "boolean") throw new ApiError(422, "validation_failed", "enabled must be a boolean");
  const sortOrder = input.sortOrder === undefined ? Number(source.sortOrder) : Number(input.sortOrder);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) throw new ApiError(422, "validation_failed", "sortOrder is invalid");
  const categoryId = input.categoryId === undefined ? source.categoryId
    : input.categoryId === null ? null : stringField(input.categoryId, "categoryId", 100, true);
  if (categoryId && !await one(env.DB, "SELECT id FROM library_categories WHERE id = ?1 AND owner_id = ?2", [categoryId, OWNER_ID])) {
    throw new ApiError(422, "validation_failed", "categoryId is invalid");
  }
  let url: string | undefined;
  if (input.url !== undefined) {
    if (source.connectorType !== "direct_rss") throw new ApiError(422, "read_only_url", "External feed URLs cannot be edited");
    url = normalizeHttpUrl(input.url);
  }
  if (source.connectorType !== "direct_rss") {
    const connection = await activeConnection(env, OWNER_ID);
    const category = categoryId ? await one<{ name: string }>(env.DB,
      "SELECT name FROM library_categories WHERE id = ?1 AND owner_id = ?2", [categoryId, OWNER_ID]) : null;
    await updateExternalSubscription(env, OWNER_ID, connection.id, id,
      { title, category: category?.name ?? "" }, crypto.randomUUID());
    await env.DB.prepare(`UPDATE sources SET custom_title = NULLIF(?1, ''), library_category_id = ?2,
      library_sort_order = ?3, updated_at = ?4 WHERE id = ?5 AND owner_id = ?6`)
      .bind(title, categoryId, sortOrder, now(), id, OWNER_ID).run();
    return new Response(null, { status: 204 });
  }
  const updated = now();
  const statements: D1PreparedStatement[] = [env.DB.prepare(`UPDATE sources SET custom_title = NULLIF(?1, ''),
    library_category_id = ?2, library_sort_order = ?3, enabled = ?4,
    sync_status = CASE WHEN ?4 = 1 THEN CASE WHEN sync_status = 'disabled' THEN 'pending' ELSE sync_status END ELSE 'disabled' END,
    updated_at = ?5 WHERE id = ?6 AND owner_id = ?7`).bind(title, categoryId, sortOrder, enabled ? 1 : 0, updated, id, OWNER_ID)];
  if (source.legacyFeedId) {
    statements.push(env.DB.prepare(`UPDATE subscriptions SET custom_title = NULLIF(?1, ''),
      category = COALESCE((SELECT name FROM library_categories WHERE id = ?2 AND owner_id = ?6), ''),
      sort_order = ?3, is_active = ?4, updated_at = ?5 WHERE feed_id = ?7 AND owner_id = ?6`)
      .bind(title, categoryId, sortOrder, enabled ? 1 : 0, updated, OWNER_ID, source.legacyFeedId));
    if (url) {
      statements.push(env.DB.prepare("UPDATE feeds SET url = ?1, fetch_status = 'pending', next_fetch_at = ?2, updated_at = ?2 WHERE id = ?3 AND owner_id = ?4")
        .bind(url, updated, source.legacyFeedId, OWNER_ID));
      statements.push(env.DB.prepare("UPDATE sources SET url = ?1, external_id = ?1 WHERE id = ?2 AND owner_id = ?3").bind(url, id, OWNER_ID));
    }
  }
  try { await env.DB.batch(statements); }
  catch { throw new ApiError(409, "feed_conflict", "The updated feed conflicts with an existing feed"); }
  return new Response(null, { status: 204 });
}

async function deleteFeed(env: LibraryEnv, id: string): Promise<Response> {
  const source = await one<{ connectorType: string; connectionId: string; legacyFeedId: string | null }>(env.DB, `
    SELECT c.connector_type AS connectorType, s.connection_id AS connectionId, s.legacy_feed_id AS legacyFeedId
    FROM sources s JOIN source_connections c ON c.id = s.connection_id
    JOIN account_source_selections selection ON selection.owner_id = s.owner_id AND selection.active_connection_id = s.connection_id
    WHERE s.id = ?1 AND s.owner_id = ?2`, [id, OWNER_ID]);
  if (!source) throw new ApiError(404, "not_found", "Feed not found");
  if (source.connectorType !== "direct_rss") {
    await deleteExternalSubscription(env, OWNER_ID, source.connectionId, id, crypto.randomUUID());
    return new Response(null, { status: 204 });
  }
  const updated = now();
  const statements = [env.DB.prepare("UPDATE sources SET enabled = 0, sync_status = 'disabled', updated_at = ?1 WHERE id = ?2 AND owner_id = ?3")
    .bind(updated, id, OWNER_ID)];
  if (source.connectorType === "direct_rss" && source.legacyFeedId) {
    statements.push(env.DB.prepare("DELETE FROM subscriptions WHERE feed_id = ?1 AND owner_id = ?2").bind(source.legacyFeedId, OWNER_ID));
  }
  await env.DB.batch(statements);
  return new Response(null, { status: 204 });
}

export async function listArticleTags(request: Request, env: LibraryEnv, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const { page, pageSize, offset } = pagination(url);
  const scope = url.searchParams.get("scope") ?? "all";
  if (!["all", "recent", "saved"].includes(scope)) throw new ApiError(422, "validation_failed", "scope is invalid");
  const categoryId = (url.searchParams.get("categoryId") ?? "").slice(0, 100);
  const feedId = (url.searchParams.get("feedId") ?? "").slice(0, 100);
  const unread = url.searchParams.get("unread") === "true";
  const excludeSelected = url.searchParams.get("excludeSelected") === "true";
  const articleQuery = (url.searchParams.get("query") ?? "").trim().slice(0, 200);
  const tagQuery = (url.searchParams.get("tagQuery") ?? "").trim().slice(0, 100);
  const locale = ["zh-CN", "en-US", "ja-JP"].includes(url.searchParams.get("targetLocale") ?? "")
    ? url.searchParams.get("targetLocale")! : "zh-CN";
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const like = `%${articleQuery}%`; const tagLike = `%${tagQuery}%`;
  const values = [OWNER_ID, scope, cutoff, categoryId, feedId, unread ? 1 : 0, articleQuery, like, tagQuery, tagLike, locale, pageSize + 1, offset];
  const items = await all<Record<string, unknown>>(env.DB, `
    SELECT tg.tag_key AS key, COALESCE(json_extract(tg.names_json, '$."' || ?11 || '"'), tg.tag_key) AS name,
      COUNT(DISTINCT a.id) AS count, COUNT(*) OVER() AS totalTags
    FROM articles a
    JOIN article_preprocessing_runs pr ON pr.article_id = a.id AND pr.is_current = 1
    JOIN article_topic_tags att ON att.run_id = pr.id
    JOIN topic_tags tg ON tg.id = att.tag_id AND tg.status = 'active'
    LEFT JOIN article_states ast ON ast.article_id = a.id AND ast.owner_id = ?1
      AND ast.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?1)
    WHERE a.owner_id = ?1
      AND (?2 = 'all' OR (?2 = 'saved' AND COALESCE(ast.is_saved, 0) = 1)
        OR (?2 = 'recent' AND ast.last_opened_at >= ?3))
      AND EXISTS (SELECT 1 FROM source_items sai JOIN sources sas ON sas.id = sai.source_id
        JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = sai.connection_id
        WHERE sai.article_id = a.id AND sas.enabled = 1)
      AND (?4 = '' OR EXISTS (SELECT 1 FROM source_items sci JOIN sources scs ON scs.id = sci.source_id
        JOIN account_source_selections sel ON sel.owner_id = ?1 AND sel.active_connection_id = sci.connection_id
        WHERE sci.article_id = a.id AND scs.enabled = 1
          AND ((?4 = 'uncategorized' AND scs.library_category_id IS NULL) OR scs.library_category_id = ?4)))
      AND (?5 = '' OR EXISTS (SELECT 1 FROM source_items sfi JOIN account_source_selections sel
        ON sel.owner_id = ?1 AND sel.active_connection_id = sfi.connection_id WHERE sfi.article_id = a.id AND sfi.source_id = ?5))
      AND (?6 = 0 OR COALESCE(ast.is_read, 0) = 0)
      AND (?7 = '' OR a.title LIKE ?8 OR EXISTS (
        SELECT 1 FROM article_preprocessing_runs search_pr
        JOIN article_preprocessing_locales search_pl ON search_pl.run_id = search_pr.id
        WHERE search_pr.article_id = a.id AND search_pr.is_current = 1
          AND (search_pl.one_line_summary LIKE ?8 OR search_pl.key_points_json LIKE ?8)))
      ${excludeSelected ? `AND NOT EXISTS (SELECT 1 FROM feeds selected_feed
        WHERE selected_feed.id = a.feed_id AND selected_feed.owner_id = ?1
          AND selected_feed.url = 'feedmind://selected/owner')` : ""}
      AND (?9 = '' OR tg.tag_key LIKE ?10 OR COALESCE(json_extract(tg.names_json, '$."' || ?11 || '"'), tg.tag_key) LIKE ?10)
    GROUP BY tg.id ORDER BY count DESC, lower(name), tg.tag_key LIMIT ?12 OFFSET ?13`, values);
  const hasMore = items.length > pageSize;
  const total = Number(items[0]?.totalTags ?? 0);
  return json({ items: items.slice(0, pageSize).map(({ totalTags: _totalTags, ...item }) => item), page, pageSize, hasMore, total, requestId }, requestId);
}

async function getArticleTag(request: Request, env: LibraryEnv, requestId: string, key: string): Promise<Response> {
  const tagKey = key.trim().slice(0, 64);
  if (!tagKey) throw new ApiError(422, "validation_failed", "tag key is invalid");
  const url = new URL(request.url);
  const locale = ["zh-CN", "en-US", "ja-JP"].includes(url.searchParams.get("targetLocale") ?? "")
    ? url.searchParams.get("targetLocale")! : "zh-CN";
  const item = await one<{ key: string; name: string }>(env.DB, `
    SELECT tag_key AS key, COALESCE(json_extract(names_json, '$."' || ?2 || '"'), tag_key) AS name
    FROM topic_tags WHERE tag_key = ?1 AND status = 'active' LIMIT 1`, [tagKey, locale]);
  if (!item) throw new ApiError(404, "not_found", "Article tag not found");
  return json({ data: { ...item, count: 0 }, requestId }, requestId);
}

export async function routeLibrary(request: Request, env: LibraryEnv, requestId: string): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/v1/library/tree" && request.method === "GET") return tree(env, requestId);
  if (path === "/v1/library/categories" && request.method === "POST") return createCategory(request, env, requestId);
  const category = path.match(/^\/v1\/library\/categories\/([^/]+)$/);
  if (category) {
    const id = decodeURIComponent(category[1]);
    if (request.method === "PATCH") return patchCategory(request, env, id);
    if (request.method === "DELETE") return deleteCategory(env, id);
  }
  const feed = path.match(/^\/v1\/library\/feeds\/([^/]+)$/);
  if (feed) {
    const id = decodeURIComponent(feed[1]);
    if (request.method === "PATCH") return patchFeed(request, env, id);
    if (request.method === "DELETE") return deleteFeed(env, id);
  }
  if (path === "/v1/article-tags" && request.method === "GET") return listArticleTags(request, env, requestId);
  const articleTag = path.match(/^\/v1\/article-tags\/([^/]+)$/);
  if (articleTag && request.method === "GET") return getArticleTag(request, env, requestId, decodeURIComponent(articleTag[1]));
  return undefined;
}
