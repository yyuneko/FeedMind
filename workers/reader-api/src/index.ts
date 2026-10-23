import type { D1Database, Queue, R2Bucket } from "../../shared/src/cloudflare";

export interface Env {
  DB: D1Database;
  CONTENT: R2Bucket;
  FEED_QUEUE: Queue<{ feedId: string; requestId: string; reason: string }>;
  READER_CREDENTIALS_KEY: string;
  MIGRATION_MODE?: string;
}

interface Identity { ownerId: string; credentialId: string; sessionId: string; loginName: string }
const READ = "user/-/state/com.google/read";
const STARRED = "user/-/state/com.google/starred";
const READING_LIST = "user/-/state/com.google/reading-list";
const now = () => new Date().toISOString();

function base64Url(bytes: Uint8Array): string {
  let binary = ""; bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function random(bytes = 32): string { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return base64Url(value); }

async function hash(key: string, value: string): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value))));
}

function equal(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let different = 0; for (let index = 0; index < left.length; index++) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const text = (value: string, status = 200) => new Response(value, { status,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

async function form(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("Content-Type") ?? "";
  if (type.includes("application/json")) {
    const value = await request.json() as Record<string, unknown>;
    return new URLSearchParams(Object.entries(value).map(([key, item]) => [key, String(item ?? "")]));
  }
  return new URLSearchParams(await request.text());
}

async function rateLimit(env: Env, key: string, maximum: number): Promise<boolean> {
  const window = new Date(); window.setUTCSeconds(0, 0); const started = window.toISOString();
  await env.DB.prepare(`INSERT INTO reader_api_rate_limits(bucket_key, window_started_at, request_count)
    VALUES (?1, ?2, 1) ON CONFLICT(bucket_key, window_started_at) DO UPDATE SET request_count = request_count + 1`)
    .bind(key, started).run();
  const row = await env.DB.prepare("SELECT request_count AS count FROM reader_api_rate_limits WHERE bucket_key = ?1 AND window_started_at = ?2")
    .bind(key, started).first<{ count: number }>();
  return Number(row?.count ?? 0) <= maximum;
}

async function login(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!await rateLimit(env, `login:${ip}`, 20)) return text("Error=RateLimit", 429);
  const input = await form(request); const loginName = (input.get("Email") ?? "").trim().toLowerCase();
  const password = input.get("Passwd") ?? "";
  const candidates = await env.DB.prepare(`SELECT id, owner_id AS ownerId, secret_hash AS secretHash
    FROM reader_api_credentials WHERE login_name = ?1 AND revoked_at IS NULL`).bind(loginName)
    .all<{ id: string; ownerId: string; secretHash: string }>();
  const suppliedHash = await hash(env.READER_CREDENTIALS_KEY, password);
  const credential = (candidates.results ?? []).find((candidate) => equal(candidate.secretHash, suppliedHash));
  if (!credential) return text("Error=BadAuthentication", 403);
  if (!await rateLimit(env, `login-credential:${credential.id}`, 30)) return text("Error=RateLimit", 429);
  const token = random(); const timestamp = now(); const expires = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO reader_api_sessions(id, credential_id, token_hash, expires_at, last_used_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)`).bind(crypto.randomUUID(), credential.id, await hash(env.READER_CREDENTIALS_KEY, token), expires, timestamp),
    env.DB.prepare("UPDATE reader_api_credentials SET last_used_at = ?1 WHERE id = ?2").bind(timestamp, credential.id),
  ]);
  return text(`SID=${token}\nLSID=${token}\nAuth=${token}\n`);
}

async function identity(request: Request, env: Env): Promise<Identity | null> {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^GoogleLogin\s+auth=(.+)$/i);
  if (!match) return null;
  const tokenHash = await hash(env.READER_CREDENTIALS_KEY, match[1].trim());
  const row = await env.DB.prepare(`SELECT credential.owner_id AS ownerId, credential.id AS credentialId,
    session.id AS sessionId, credential.login_name AS loginName
    FROM reader_api_sessions session JOIN reader_api_credentials credential ON credential.id = session.credential_id
    WHERE session.token_hash = ?1 AND session.revoked_at IS NULL AND credential.revoked_at IS NULL
      AND session.expires_at > ?2`).bind(tokenHash, now()).first<Identity>();
  if (row) await env.DB.batch([
    env.DB.prepare("UPDATE reader_api_sessions SET last_used_at = ?1 WHERE id = ?2").bind(now(), row.sessionId),
    env.DB.prepare("UPDATE reader_api_credentials SET last_used_at = ?1 WHERE id = ?2").bind(now(), row.credentialId),
  ]);
  return row;
}

async function writeToken(env: Env, sessionId: string, hourOffset = 0): Promise<string> {
  const hour = Math.floor(Date.now() / 3_600_000) + hourOffset;
  return hash(env.READER_CREDENTIALS_KEY, `write:${sessionId}:${hour}`);
}

async function requireWriteToken(request: Request, env: Env, user: Identity, input: URLSearchParams): Promise<Response | null> {
  const supplied = input.get("T") ?? "";
  if (!equal(supplied, await writeToken(env, user.sessionId)) && !equal(supplied, await writeToken(env, user.sessionId, -1))) {
    return text("Invalid token", 401);
  }
  if (!await rateLimit(env, `write:${user.credentialId}`, 240)) return text("Rate limit exceeded", 429);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!await rateLimit(env, `write-ip:${ip}`, 480)) return text("Rate limit exceeded", 429);
  return null;
}

async function itemId(env: Env, articleId: string): Promise<string> {
  const existing = await env.DB.prepare("SELECT item_id AS itemId FROM reader_api_item_ids WHERE article_id = ?1")
    .bind(articleId).first<{ itemId: string }>();
  if (existing) return existing.itemId;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(articleId));
  const hex = Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const value = `tag:google.com,2005:reader/item/${hex}`;
  await env.DB.prepare("INSERT OR IGNORE INTO reader_api_item_ids(article_id, item_id) VALUES (?1, ?2)").bind(articleId, value).run();
  return value;
}

function normalizeItemId(value: string): string {
  if (value.startsWith("tag:google.com,2005:reader/item/")) return value;
  if (/^[0-9a-f]{16}$/i.test(value)) return `tag:google.com,2005:reader/item/${value.toLowerCase()}`;
  if (/^-?\d+$/.test(value)) {
    try {
      const modulus = 1n << 64n; let numeric = BigInt(value) % modulus;
      if (numeric < 0) numeric += modulus;
      return `tag:google.com,2005:reader/item/${numeric.toString(16).padStart(16, "0")}`;
    } catch { return value; }
  }
  return value;
}

async function subscriptions(env: Env, user: Identity): Promise<Response> {
  const result = await env.DB.prepare(`SELECT source.id, source.title, source.url, source.site_url AS siteUrl,
    COALESCE((SELECT json_group_array(name) FROM source_categories category WHERE category.source_id = source.id), '[]') AS categoriesJson
    FROM sources source JOIN source_connections connection ON connection.id = source.connection_id
    WHERE source.owner_id = ?1 AND connection.connector_type = 'direct_rss' AND source.enabled = 1
    ORDER BY lower(source.title), source.id`).bind(user.ownerId)
    .all<{ id: string; title: string; url: string; siteUrl: string | null; categoriesJson: string }>();
  return json({ subscriptions: (result.results ?? []).map((source) => ({ id: `feed/${source.id}`, title: source.title,
    url: source.url, htmlUrl: source.siteUrl ?? "", categories: (JSON.parse(source.categoriesJson || "[]") as string[])
      .map((label) => ({ id: `user/-/label/${label}`, label })) })) });
}

async function tagList(env: Env, user: Identity): Promise<Response> {
  const result = await env.DB.prepare(`SELECT DISTINCT category.name FROM source_categories category
    JOIN sources source ON source.id = category.source_id JOIN source_connections connection ON connection.id = source.connection_id
    WHERE source.owner_id = ?1 AND connection.connector_type = 'direct_rss' ORDER BY lower(category.name)`)
    .bind(user.ownerId).all<{ name: string }>();
  return json({ tags: (result.results ?? []).map((row) => ({ id: `user/-/label/${row.name}`, sortid: "", unreadLimit: 0 })) });
}

function streamFilter(stream: string): { sql: string; value?: string } {
  if (stream === STARRED) return { sql: "state.is_saved = 1" };
  if (stream === READ) return { sql: "state.is_read = 1" };
  if (stream.startsWith("feed/")) return { sql: "source.id = ?", value: stream.slice(5) };
  if (stream.startsWith("user/-/label/")) return { sql: "category.name = ?", value: decodeURIComponent(stream.slice(13)) };
  return { sql: "1 = 1" };
}

async function articleRows(request: Request, env: Env, user: Identity) {
  const url = new URL(request.url); const pathname = url.pathname;
  const stream = decodeURIComponent(pathname.split("/stream/contents/")[1] ?? url.searchParams.get("s") ?? READING_LIST);
  const filter = streamFilter(stream); const count = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("n") ?? "20", 10) || 20));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("c") ?? "0", 10) || 0);
  const olderThan = Number.parseInt(url.searchParams.get("ot") ?? "0", 10) || 0;
  const values: unknown[] = [user.ownerId, `connection:direct-rss:${user.ownerId}`];
  let predicate = filter.sql;
  if (filter.value !== undefined) { values.push(filter.value); predicate = predicate.replace("?", `?${values.length}`); }
  for (const excluded of url.searchParams.getAll("xt")) {
    if (excluded === READ) predicate += " AND COALESCE(state.is_read, 0) = 0";
    if (excluded === STARRED) predicate += " AND COALESCE(state.is_saved, 0) = 0";
  }
  values.push(olderThan, count + 1, offset);
  const result = await env.DB.prepare(`SELECT DISTINCT article.id, article.title, article.author, article.summary,
    article.canonical_url AS url, article.published_at AS publishedAt, article.updated_at AS updatedAt,
    article.source_html_key AS contentKey, source.id AS sourceId, source.title AS sourceTitle,
    COALESCE(state.is_read, 0) AS isRead, COALESCE(state.is_saved, 0) AS isSaved
    FROM source_items item JOIN sources source ON source.id = item.source_id
    JOIN source_connections connection ON connection.id = item.connection_id AND connection.connector_type = 'direct_rss'
    JOIN articles article ON article.id = item.article_id
    LEFT JOIN source_categories category ON category.source_id = source.id
    LEFT JOIN article_states state ON state.owner_id = ?1 AND state.connection_id = ?2 AND state.article_id = article.id
    WHERE item.owner_id = ?1 AND source.enabled = 1 AND ${predicate}
      AND (?${values.length - 2} = 0 OR CAST(strftime('%s', COALESCE(article.updated_at, article.created_at)) AS INTEGER) >= ?${values.length - 2})
    ORDER BY COALESCE(article.published_at, article.created_at) DESC, article.id DESC LIMIT ?${values.length - 1} OFFSET ?${values.length}`)
    .bind(...values).all<Record<string, unknown>>();
  return { rows: result.results ?? [], count, offset };
}

async function streamContents(request: Request, env: Env, user: Identity): Promise<Response> {
  const { rows, count, offset } = await articleRows(request, env, user); const visible = rows.slice(0, count);
  const items = [];
  for (const row of visible) {
    const object = row.contentKey ? await env.CONTENT.get(String(row.contentKey)) : null;
    const categories = [READING_LIST]; if (Number(row.isRead)) categories.push(READ); if (Number(row.isSaved)) categories.push(STARRED);
    items.push({ id: await itemId(env, String(row.id)), crawlTimeMsec: String(Date.parse(String(row.updatedAt)) || Date.now()),
      timestampUsec: String((Date.parse(String(row.publishedAt ?? row.updatedAt)) || Date.now()) * 1000), title: row.title,
      author: row.author ?? "", categories, origin: { streamId: `feed/${row.sourceId}`, title: row.sourceTitle },
      alternate: [{ href: row.url, type: "text/html" }], summary: { direction: "ltr", content: row.summary ?? "" },
      content: { direction: "ltr", content: object ? await object.text() : row.summary ?? "" } });
  }
  return json({ direction: "ltr", id: READING_LIST, title: "FeedMind", updated: Math.floor(Date.now() / 1000),
    items, ...(rows.length > count ? { continuation: String(offset + count) } : {}) });
}

async function itemContents(request: Request, env: Env, user: Identity): Promise<Response> {
  const input = await form(request); const ids = input.getAll("i");
  const items = [];
  for (const id of ids.slice(0, 100)) {
    const normalizedId = normalizeItemId(id);
    const row = await env.DB.prepare(`SELECT article.id, article.title, article.author, article.summary,
      article.canonical_url AS url, article.updated_at AS updatedAt, article.source_html_key AS contentKey,
      source.id AS sourceId, source.title AS sourceTitle, COALESCE(state.is_read, 0) AS isRead,
      COALESCE(state.is_saved, 0) AS isSaved FROM reader_api_item_ids mapped JOIN articles article ON article.id = mapped.article_id
      JOIN source_items item ON item.article_id = article.id AND item.connection_id = ?1 JOIN sources source ON source.id = item.source_id
      LEFT JOIN article_states state ON state.owner_id = ?2 AND state.connection_id = ?1 AND state.article_id = article.id
      WHERE mapped.item_id = ?3 AND article.owner_id = ?2 AND source.owner_id = ?2 AND source.enabled = 1 LIMIT 1`)
      .bind(`connection:direct-rss:${user.ownerId}`, user.ownerId, normalizedId).first<Record<string, unknown>>();
    if (!row) continue;
    const object = row.contentKey ? await env.CONTENT.get(String(row.contentKey)) : null;
    const categories = [READING_LIST]; if (Number(row.isRead)) categories.push(READ); if (Number(row.isSaved)) categories.push(STARRED);
    items.push({ id: normalizedId, title: row.title, author: row.author ?? "", categories, origin: { streamId: `feed/${row.sourceId}`, title: row.sourceTitle },
      alternate: [{ href: row.url, type: "text/html" }], content: { direction: "ltr", content: object ? await object.text() : row.summary ?? "" } });
  }
  return json({ items });
}

async function subscriptionEdit(request: Request, env: Env, user: Identity, supplied?: URLSearchParams): Promise<Response> {
  const input = supplied ?? await form(request); const rejected = await requireWriteToken(request, env, user, input); if (rejected) return rejected;
  const action = input.get("ac") ?? ""; const stream = input.get("s") ?? ""; const raw = stream.startsWith("feed/") ? stream.slice(5) : stream;
  const title = (input.get("t") ?? "").slice(0, 500);
  const labels = input.getAll("a").map((value) => value.replace(/^user\/[^/]+\/label\//, "").slice(0, 200)).filter(Boolean);
  const removedLabels = input.getAll("r").map((value) => value.replace(/^user\/[^/]+\/label\//, "").slice(0, 200)).filter(Boolean);
  const label = labels[0] ?? "";
  const timestamp = now(); const connectionId = `connection:direct-rss:${user.ownerId}`;
  if (action === "subscribe") {
    let url: string; try { const parsed = new URL(raw); if (!/^https?:$/.test(parsed.protocol)) throw new Error(); url = parsed.toString(); }
    catch { return text("Invalid feed URL", 400); }
    const feedId = crypto.randomUUID();
    const feed = await env.DB.prepare(`INSERT INTO feeds(id, owner_id, url, title, fetch_status, next_fetch_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5, ?5) ON CONFLICT(owner_id, url) DO UPDATE SET updated_at = excluded.updated_at RETURNING id`)
      .bind(feedId, user.ownerId, url, title, timestamp).first<{ id: string }>();
    if (!feed) return text("Unable to subscribe", 500);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO subscriptions(id, owner_id, feed_id, category, custom_title, is_active, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, NULLIF(?5, ''), 1, ?6, ?6) ON CONFLICT(owner_id, feed_id) DO UPDATE SET
        category = CASE WHEN excluded.category = '' THEN subscriptions.category ELSE excluded.category END,
        custom_title = COALESCE(excluded.custom_title, subscriptions.custom_title), is_active = 1, updated_at = excluded.updated_at`)
        .bind(crypto.randomUUID(), user.ownerId, feed.id, label, title, timestamp),
      env.DB.prepare(`INSERT INTO sources(id, owner_id, connection_id, external_id, kind, title, url, enabled, sync_status,
        legacy_feed_id, metadata_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'feed', ?5, ?4, 1, 'pending', ?1, '{}', ?6, ?6)
        ON CONFLICT(connection_id, external_id) DO UPDATE SET enabled = 1, sync_status = 'pending', updated_at = excluded.updated_at`)
        .bind(feed.id, user.ownerId, connectionId, url, title, timestamp),
    ]);
    if (label) await env.DB.prepare("INSERT OR IGNORE INTO source_categories(source_id, name, sort_order) VALUES (?1, ?2, 0)").bind(feed.id, label).run();
    await env.FEED_QUEUE.send({ feedId: feed.id, requestId: crypto.randomUUID(), reason: "subscription_created" }, { contentType: "json" });
    return text("OK");
  }
  const source = await env.DB.prepare(`SELECT source.id, source.legacy_feed_id AS feedId FROM sources source
    WHERE source.owner_id = ?1 AND source.connection_id = ?2 AND (source.id = ?3 OR source.external_id = ?3)`)
    .bind(user.ownerId, connectionId, raw).first<{ id: string; feedId: string }>();
  if (!source) return text("Subscription not found", 404);
  if (action === "unsubscribe") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM subscriptions WHERE owner_id = ?1 AND feed_id = ?2").bind(user.ownerId, source.feedId),
      env.DB.prepare("UPDATE sources SET enabled = 0, sync_status = 'disabled', updated_at = ?1 WHERE id = ?2").bind(timestamp, source.id),
    ]); return text("OK");
  }
  if (action === "edit") {
    const statements = [
      env.DB.prepare("UPDATE feeds SET title = COALESCE(NULLIF(?1, ''), title), updated_at = ?2 WHERE id = ?3 AND owner_id = ?4").bind(title, timestamp, source.feedId, user.ownerId),
      env.DB.prepare(`UPDATE subscriptions SET custom_title = NULLIF(?1, ''),
        category = CASE WHEN ?2 <> '' THEN ?2 WHEN category IN (${removedLabels.map((_, index) => `?${index + 6}`).join(",") || "NULL"}) THEN '' ELSE category END,
        updated_at = ?3 WHERE feed_id = ?4 AND owner_id = ?5`).bind(title, label, timestamp, source.feedId, user.ownerId, ...removedLabels),
      env.DB.prepare("UPDATE sources SET custom_title = NULLIF(?1, ''), updated_at = ?2 WHERE id = ?3").bind(title, timestamp, source.id),
      ...removedLabels.map((removed) => env.DB.prepare("DELETE FROM source_categories WHERE source_id = ?1 AND name = ?2").bind(source.id, removed)),
      ...labels.map((added, index) => env.DB.prepare("INSERT OR IGNORE INTO source_categories(source_id, name, sort_order) VALUES (?1, ?2, ?3)").bind(source.id, added, index)),
    ];
    await env.DB.batch(statements);
    return text("OK");
  }
  return text("Unsupported action", 400);
}

async function editTag(request: Request, env: Env, user: Identity): Promise<Response> {
  const input = await form(request); const rejected = await requireWriteToken(request, env, user, input); if (rejected) return rejected;
  const add = input.getAll("a"); const remove = input.getAll("r"); const ids = input.getAll("i"); const timestamp = now();
  const connectionId = `connection:direct-rss:${user.ownerId}`;
  for (const item of ids.slice(0, 100)) {
    const normalizedItem = normalizeItemId(item);
    const row = await env.DB.prepare(`SELECT mapped.article_id AS articleId FROM reader_api_item_ids mapped
      JOIN articles article ON article.id = mapped.article_id JOIN source_items source_item ON source_item.article_id = article.id
      JOIN sources source ON source.id = source_item.source_id
      WHERE mapped.item_id = ?1 AND article.owner_id = ?2 AND source_item.connection_id = ?3 AND source.enabled = 1 LIMIT 1`)
      .bind(normalizedItem, user.ownerId, connectionId).first<{ articleId: string }>(); if (!row) continue;
    const current = await env.DB.prepare("SELECT is_read AS isRead, is_saved AS isSaved FROM article_states WHERE owner_id = ?1 AND connection_id = ?2 AND article_id = ?3")
      .bind(user.ownerId, connectionId, row.articleId).first<{ isRead: number; isSaved: number }>();
    let isRead = Boolean(current?.isRead); let isSaved = Boolean(current?.isSaved);
    if (add.includes(READ)) isRead = true; if (remove.includes(READ)) isRead = false;
    if (add.includes(STARRED)) isSaved = true; if (remove.includes(STARRED)) isSaved = false;
    await env.DB.prepare(`INSERT INTO article_states(owner_id, connection_id, article_id, is_read, is_saved, reading_progress, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6) ON CONFLICT(owner_id, connection_id, article_id) DO UPDATE SET
      is_read = excluded.is_read, is_saved = excluded.is_saved, updated_at = excluded.updated_at`)
      .bind(user.ownerId, connectionId, row.articleId, isRead ? 1 : 0, isSaved ? 1 : 0, timestamp).run();
  }
  return text("OK");
}

async function unreadCount(env: Env, user: Identity): Promise<Response> {
  const connectionId = `connection:direct-rss:${user.ownerId}`;
  const rows = await env.DB.prepare(`SELECT source.id, COUNT(DISTINCT item.article_id) AS count,
    MAX(CAST(strftime('%s', COALESCE(article.published_at, article.created_at)) AS INTEGER)) AS newest
    FROM sources source JOIN source_items item ON item.source_id = source.id JOIN articles article ON article.id = item.article_id
    LEFT JOIN article_states state ON state.owner_id = ?1 AND state.connection_id = ?2 AND state.article_id = article.id
    WHERE source.owner_id = ?1 AND source.connection_id = ?2 AND source.enabled = 1 AND COALESCE(state.is_read, 0) = 0
    GROUP BY source.id`).bind(user.ownerId, connectionId).all<{ id: string; count: number; newest: number }>();
  return json({ max: 1000, unreadcounts: (rows.results ?? []).map((row) => ({ id: `feed/${row.id}`, count: Number(row.count), newestItemTimestampUsec: String(Number(row.newest ?? 0) * 1_000_000) })) });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname.replace(/\/+/g, "/");
  if (path.endsWith("/accounts/ClientLogin") && request.method === "POST") return login(request, env);
  const user = await identity(request, env); if (!user) return text("Unauthorized", 401);
  if (!await rateLimit(env, `read:${user.credentialId}`, 1200)) return text("Rate limit exceeded", 429);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!await rateLimit(env, `read-ip:${ip}`, 2400)) return text("Rate limit exceeded", 429);
  if (path.endsWith("/token")) return text(await writeToken(env, user.sessionId));
  if (path.endsWith("/user-info")) return json({ userId: user.ownerId, userName: user.loginName, userProfileId: user.ownerId, userEmail: user.loginName });
  if (path.endsWith("/subscription/list")) return subscriptions(env, user);
  if ((path.endsWith("/subscription/edit") || path.endsWith("/subscription/quickadd")) && request.method === "POST") {
    if (path.endsWith("/quickadd")) {
      const input = await form(request); input.set("ac", "subscribe"); input.set("s", `feed/${input.get("quickadd") ?? input.get("s") ?? ""}`);
      return subscriptionEdit(request, env, user, input);
    }
    return subscriptionEdit(request, env, user);
  }
  if (path.endsWith("/tag/list")) return tagList(env, user);
  if (path.includes("/stream/contents/")) return streamContents(request, env, user);
  if (path.endsWith("/stream/items/contents")) return itemContents(request, env, user);
  if (path.endsWith("/stream/items/ids")) {
    const result = await streamContents(request, env, user); const body = await result.json() as { items?: Array<{ id: string; timestampUsec?: string }>; continuation?: string };
    return json({ itemRefs: (body.items ?? []).map((item) => ({ id: item.id, directStreamIds: [], timestampUsec: item.timestampUsec ?? "0" })), continuation: body.continuation });
  }
  if (path.endsWith("/unread-count")) return unreadCount(env, user);
  if (path.endsWith("/edit-tag") && request.method === "POST") return editTag(request, env, user);
  if (path.endsWith("/mark-all-as-read") && request.method === "POST") {
    const input = await form(request); const rejected = await requireWriteToken(request, env, user, input); if (rejected) return rejected;
    const timestamp = now(); const connectionId = `connection:direct-rss:${user.ownerId}`;
    const stream = input.get("s") ?? READING_LIST;
    const feedId = stream.startsWith("feed/") ? stream.slice(5) : "";
    const label = stream.startsWith("user/-/label/") ? decodeURIComponent(stream.slice(13)) : "";
    const savedOnly = stream === STARRED ? 1 : 0; const readOnly = stream === READ ? 1 : 0;
    if (![READING_LIST, STARRED, READ].includes(stream) && !feedId && !label) return text("Unsupported stream", 400);
    const rawTimestamp = Number(input.get("ts") ?? 0);
    const cutoffSeconds = Number.isFinite(rawTimestamp) && rawTimestamp > 0
      ? Math.floor(rawTimestamp / (rawTimestamp > 10_000_000_000_000 ? 1_000_000 : rawTimestamp > 10_000_000_000 ? 1000 : 1)) : 0;
    await env.DB.prepare(`INSERT INTO article_states(owner_id, connection_id, article_id, is_read, is_saved, reading_progress, updated_at)
      SELECT DISTINCT ?1, ?2, item.article_id, 1, COALESCE(state.is_saved, 0), COALESCE(state.reading_progress, 0), ?3
      FROM source_items item JOIN sources source ON source.id = item.source_id AND source.enabled = 1
      JOIN articles article ON article.id = item.article_id
      LEFT JOIN article_states state ON state.owner_id = ?1 AND state.connection_id = ?2 AND state.article_id = item.article_id
      WHERE item.owner_id = ?1 AND item.connection_id = ?2
        AND (?4 = '' OR source.id = ?4)
        AND (?5 = '' OR EXISTS (SELECT 1 FROM source_categories category WHERE category.source_id = source.id AND category.name = ?5))
        AND (?6 = 0 OR COALESCE(state.is_saved, 0) = 1)
        AND (?7 = 0 OR COALESCE(state.is_read, 0) = 1)
        AND (?8 = 0 OR CAST(strftime('%s', COALESCE(article.published_at, article.created_at)) AS INTEGER) <= ?8)
      ON CONFLICT(owner_id, connection_id, article_id) DO UPDATE SET is_read = 1, updated_at = excluded.updated_at`)
      .bind(user.ownerId, connectionId, timestamp, feedId, label, savedOnly, readOnly, cutoffSeconds).run(); return text("OK");
  }
  if (path.endsWith("/preference/list") || path.endsWith("/preference/stream/list")) return json({ prefs: {}, streamprefs: {} });
  return json({ error: "unsupported_endpoint" }, 404);
}

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+/g, "/");
  const isWrite = path.endsWith("/accounts/ClientLogin") || path.endsWith("/subscription/edit") ||
    path.endsWith("/subscription/quickadd") || path.endsWith("/edit-tag") || path.endsWith("/mark-all-as-read");
  if (env.MIGRATION_MODE === "paused" || (env.MIGRATION_MODE === "read_only" && isWrite)) {
    const response = text("Error=MigrationInProgress", 503);
    response.headers.set("Retry-After", "300");
    return response;
  }
  try { return await route(request, env); }
  catch (error) {
    console.error({ service: "feedmind-reader-api", event: "request_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return text("Internal server error", 500);
  }
} };
