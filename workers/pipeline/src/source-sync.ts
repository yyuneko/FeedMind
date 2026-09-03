import { decryptCredentials } from "../../shared/src/credentials";
import type { D1Database, Queue, R2Bucket } from "../../shared/src/cloudflare";
import { connectorFor, type ConnectorContext, type ConnectorType, type NormalizedSourceItem, type SyncPolicy } from "./connectors";
import type { ArticleMessage } from "./pipeline";

export interface SourceSyncMessage { connectionId: string; sourceId?: string; selectionRevision?: number; requestId: string; reason?: string }

export interface SourceSyncEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
  ARTICLE_QUEUE: Queue<ArticleMessage>;
  SOURCE_CREDENTIALS_KEY: string;
  FEED_INTERVAL_MINUTES: string;
}

interface ConnectionRow {
  id: string; ownerId: string; connectorType: ConnectorType; baseUrl: string | null;
  credentialsEncrypted: string | null; syncPolicy: SyncPolicy; cursorJson: string;
}

const timestamp = () => new Date().toISOString();

function safeJson(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 100);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function context(connection: ConnectionRow, env: SourceSyncEnv): Promise<ConnectorContext> {
  return {
    baseUrl: connection.baseUrl ?? "",
    credentials: connection.credentialsEncrypted
      ? await decryptCredentials(env.SOURCE_CREDENTIALS_KEY, connection.credentialsEncrypted) : {},
  };
}

async function selectionIsCurrent(connection: ConnectionRow, message: SourceSyncMessage, env: SourceSyncEnv): Promise<boolean> {
  const selected = await env.DB.prepare(`SELECT revision FROM account_source_selections
    WHERE owner_id = ?1 AND active_connection_id = ?2`).bind(connection.ownerId, connection.id).first<{ revision: number }>();
  return Boolean(selected) && (message.selectionRevision === undefined
    || Number(message.selectionRevision) === Number(selected!.revision));
}

async function releaseStaleSync(connection: ConnectionRow, env: SourceSyncEnv): Promise<void> {
  await env.DB.prepare("UPDATE source_connections SET status = 'ok', updated_at = ?1 WHERE id = ?2 AND status = 'syncing'")
    .bind(timestamp(), connection.id).run();
}

async function storeItem(connection: ConnectionRow, item: NormalizedSourceItem, env: SourceSyncEnv, requestId: string): Promise<void> {
  const source = await env.DB.prepare(`SELECT id FROM sources WHERE connection_id = ?1 AND external_id = ?2 AND enabled = 1`)
    .bind(connection.id, item.sourceExternalId).first<{ id: string }>();
  if (!source) return;
  await env.DB.prepare("UPDATE sources SET sync_status = 'syncing', last_error_code = NULL, updated_at = ?1 WHERE id = ?2")
    .bind(timestamp(), source.id).run();
  const mapped = await env.DB.prepare(`SELECT article_id AS articleId FROM source_items WHERE connection_id = ?1 AND external_item_id = ?2`)
    .bind(connection.id, item.externalItemId).first<{ articleId: string }>();
  const canonicalUrl = item.canonicalUrl || `feedmind://source-item/${connection.id}/${await sha256(item.externalItemId)}`;
  const existing = mapped ?? await env.DB.prepare("SELECT id AS articleId FROM articles WHERE owner_id = ?1 AND canonical_url = ?2")
    .bind(connection.ownerId, canonicalUrl).first<{ articleId: string }>();
  const now = timestamp();
  const articleId = existing?.articleId ?? crypto.randomUUID();
  if (!existing) {
    await env.DB.prepare(`INSERT INTO articles
      (id, owner_id, feed_id, canonical_url, external_id, title, author, summary, published_at, parse_status, created_at, updated_at)
      VALUES (?1, ?2, NULL, ?3, ?4, ?5, NULLIF(?6, ''), NULLIF(?7, ''), ?8, 'pending', ?9, ?9)`)
      .bind(articleId, connection.ownerId, canonicalUrl, item.externalItemId, item.title, item.author, item.summary, item.publishedAt, now).run();
  } else {
    await env.DB.prepare(`UPDATE articles SET title = COALESCE(NULLIF(?1, ''), title), author = COALESCE(NULLIF(?2, ''), author),
      summary = COALESCE(NULLIF(?3, ''), summary), published_at = COALESCE(?4, published_at), updated_at = ?5 WHERE id = ?6`)
      .bind(item.title, item.author, item.summary, item.publishedAt, now, articleId).run();
  }
  let upstreamContentKey: string | null = null;
  if (item.upstreamHtml) {
    upstreamContentKey = `source-items/${connection.id}/${await sha256(item.externalItemId)}/content.html`;
    await env.CONTENT.put(upstreamContentKey, new TextEncoder().encode(item.upstreamHtml), { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  }
  await env.DB.prepare(`INSERT INTO source_items
    (id, owner_id, connection_id, source_id, external_item_id, article_id, canonical_url, upstream_content_key,
     upstream_is_read, upstream_is_saved, upstream_updated_at, metadata_json, first_seen_at, last_seen_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '{}', ?12, ?12)
    ON CONFLICT(connection_id, external_item_id) DO UPDATE SET source_id = excluded.source_id, article_id = excluded.article_id,
      canonical_url = excluded.canonical_url, upstream_content_key = COALESCE(excluded.upstream_content_key, source_items.upstream_content_key),
      upstream_is_read = excluded.upstream_is_read, upstream_is_saved = excluded.upstream_is_saved,
      upstream_updated_at = excluded.upstream_updated_at, last_seen_at = excluded.last_seen_at`)
    .bind(crypto.randomUUID(), connection.ownerId, connection.id, source.id, item.externalItemId, articleId, item.canonicalUrl,
      upstreamContentKey, item.isRead == null ? null : item.isRead ? 1 : 0, item.isSaved == null ? null : item.isSaved ? 1 : 0,
      item.updatedAt, now).run();
  if (connection.syncPolicy !== "feedmind_primary" && (item.isRead != null || item.isSaved != null)) {
    const pending = await env.DB.prepare(`SELECT 1 AS found FROM state_sync_outbox o JOIN source_items si ON si.id = o.source_item_id
      WHERE si.connection_id = ?1 AND si.external_item_id = ?2 AND o.status IN ('pending', 'running', 'failed') LIMIT 1`)
      .bind(connection.id, item.externalItemId).first();
    if (!pending) await env.DB.prepare(`INSERT INTO article_states(owner_id, connection_id, article_id, is_read, is_saved, reading_progress, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6) ON CONFLICT(owner_id, connection_id, article_id) DO UPDATE SET
      is_read = excluded.is_read, is_saved = excluded.is_saved, updated_at = excluded.updated_at`)
      .bind(connection.ownerId, connection.id, articleId, item.isRead ? 1 : 0, item.isSaved ? 1 : 0, now).run();
  }
  if (!existing) {
    await env.DB.prepare(`INSERT OR IGNORE INTO article_parse_tasks
      (id, article_id, source_url, status, requested_by, request_id, created_at)
      VALUES (?1, ?2, ?3, 'pending', 'system', ?4, ?5)`)
      .bind(crypto.randomUUID(), articleId, canonicalUrl, requestId, now).run();
    await env.ARTICLE_QUEUE.send({ articleId, requestId, reason: "source_discovered" }, { contentType: "json" });
  }
  await env.DB.prepare("UPDATE sources SET sync_status = 'ok', last_error_code = NULL, last_synced_at = ?1, updated_at = ?1 WHERE id = ?2")
    .bind(timestamp(), source.id).run();
}

async function flushOutbox(connection: ConnectionRow, connectorContext: ConnectorContext, env: SourceSyncEnv): Promise<void> {
  if (connection.syncPolicy === "feedmind_primary") return;
  const rows = await env.DB.prepare(`SELECT o.id, si.external_item_id AS externalItemId, o.desired_read AS desiredRead, o.desired_saved AS desiredSaved
    FROM state_sync_outbox o JOIN source_items si ON si.id = o.source_item_id
    WHERE o.connection_id = ?1 AND o.status IN ('pending', 'failed') AND o.next_attempt_at <= ?2 ORDER BY o.created_at LIMIT 100`)
    .bind(connection.id, timestamp()).all<{ id: string; externalItemId: string; desiredRead: number | null; desiredSaved: number | null }>();
  for (const row of rows.results ?? []) {
    try {
      const claimed = await env.DB.prepare(`UPDATE state_sync_outbox SET status = 'running', updated_at = ?1
        WHERE id = ?2 AND status IN ('pending', 'failed')`).bind(timestamp(), row.id).run();
      if ((claimed.meta?.changes ?? 0) !== 1) continue;
      await connectorFor(connection.connectorType).pushStates(connectorContext, [{ externalItemId: row.externalItemId,
        ...(row.desiredRead == null ? {} : { isRead: row.desiredRead === 1 }),
        ...(row.desiredSaved == null ? {} : { isSaved: row.desiredSaved === 1 }) }]);
      await env.DB.prepare("UPDATE state_sync_outbox SET status = 'completed', updated_at = ?1 WHERE id = ?2").bind(timestamp(), row.id).run();
    } catch (error) {
      await env.DB.prepare(`UPDATE state_sync_outbox SET status = 'failed', attempt_count = attempt_count + 1,
        last_error_code = ?1, next_attempt_at = ?2, updated_at = ?3 WHERE id = ?4`)
        .bind(safeError(error), new Date(Date.now() + 300_000).toISOString(), timestamp(), row.id).run();
    }
  }
}

async function syncRemoteStates(connection: ConnectionRow, connectorContext: ConnectorContext, env: SourceSyncEnv): Promise<void> {
  if (connection.syncPolicy === "feedmind_primary") return;
  const items = await env.DB.prepare(`SELECT id, external_item_id AS externalItemId, article_id AS articleId
    FROM source_items WHERE connection_id = ?1 ORDER BY last_seen_at DESC LIMIT 500`)
    .bind(connection.id).all<{ id: string; externalItemId: string; articleId: string }>();
  const rows = items.results ?? [];
  const states = await connectorFor(connection.connectorType).pullStates(connectorContext, rows.map((item) => item.externalItemId));
  const updated = timestamp();
  for (const item of rows) {
    const state = states.get(item.externalItemId); if (!state) continue;
    await env.DB.prepare(`UPDATE source_items SET upstream_is_read = ?1, upstream_is_saved = ?2,
      upstream_updated_at = ?3 WHERE id = ?4`).bind(state.isRead ? 1 : 0, state.isSaved ? 1 : 0, updated, item.id).run();
    const pending = await env.DB.prepare(`SELECT 1 AS found FROM state_sync_outbox WHERE source_item_id = ?1
      AND status IN ('pending','running','failed') LIMIT 1`).bind(item.id).first();
    if (!pending) await env.DB.prepare(`INSERT INTO article_states(owner_id, connection_id, article_id, is_read, is_saved, reading_progress, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6) ON CONFLICT(owner_id, connection_id, article_id) DO UPDATE SET
      is_read = excluded.is_read, is_saved = excluded.is_saved, updated_at = excluded.updated_at`)
      .bind(connection.ownerId, connection.id, item.articleId, state.isRead ? 1 : 0, state.isSaved ? 1 : 0, updated).run();
  }
}

export async function processSourceSync(message: SourceSyncMessage, env: SourceSyncEnv): Promise<void> {
  const connection = await env.DB.prepare(`SELECT id, owner_id AS ownerId, connector_type AS connectorType, base_url AS baseUrl,
    credentials_encrypted AS credentialsEncrypted, sync_policy AS syncPolicy, cursor_json AS cursorJson
    FROM source_connections WHERE id = ?1 AND status <> 'disabled'`).bind(message.connectionId).first<ConnectionRow>();
  if (!connection || connection.connectorType === "direct_rss") return;
  if (!await selectionIsCurrent(connection, message, env)) return;
  const claimed = await env.DB.prepare("UPDATE source_connections SET status = 'syncing', updated_at = ?1 WHERE id = ?2 AND status <> 'syncing'")
    .bind(timestamp(), connection.id).run();
  if ((claimed.meta?.changes ?? 0) !== 1) throw new Error("connection_sync_active");
  try {
    const connector = connectorFor(connection.connectorType);
    const connectorContext = await context(connection, env);
    const discovered = await connector.discoverSources(connectorContext);
    if (!await selectionIsCurrent(connection, message, env)) { await releaseStaleSync(connection, env); return; }
    const now = timestamp();
    await env.DB.prepare(`UPDATE sources SET enabled = 0, sync_status = 'disabled', updated_at = ?1
      WHERE connection_id = ?2`).bind(now, connection.id).run();
    for (const source of discovered) {
      const id = crypto.randomUUID();
      const stored = await env.DB.prepare(`INSERT INTO sources
        (id, owner_id, connection_id, external_id, kind, title, url, site_url, enabled, sync_status, metadata_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 'ok', '{}', ?9, ?9)
        ON CONFLICT(connection_id, external_id) DO UPDATE SET title = excluded.title, url = excluded.url,
          site_url = excluded.site_url, enabled = 1, sync_status = 'ok', updated_at = excluded.updated_at RETURNING id`)
        .bind(id, connection.ownerId, connection.id, source.externalId, source.kind, source.title, source.url, source.siteUrl, now).first<{ id: string }>();
      if (!stored) continue;
      await env.DB.prepare("DELETE FROM source_categories WHERE source_id = ?1").bind(stored.id).run();
      for (const [index, category] of [...new Set(source.categories)].entries()) {
        await env.DB.prepare("INSERT INTO source_categories(source_id, name, sort_order) VALUES (?1, ?2, ?3)").bind(stored.id, category, index).run();
      }
      const initialCategory = [...new Set(source.categories.map((category) => category.trim()).filter(Boolean))][0];
      if (initialCategory) {
        await env.DB.prepare(`INSERT OR IGNORE INTO library_categories(id, owner_id, name, sort_order, created_at, updated_at)
          VALUES (?1, ?2, ?3, COALESCE((SELECT MAX(sort_order) + 1 FROM library_categories WHERE owner_id = ?2), 0), ?4, ?4)
          `).bind(crypto.randomUUID(), connection.ownerId, initialCategory, now).run();
        await env.DB.prepare(`UPDATE sources SET library_category_id =
          (SELECT id FROM library_categories WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE LIMIT 1)
          WHERE id = ?3`).bind(connection.ownerId, initialCategory, stored.id).run();
      } else {
        await env.DB.prepare("UPDATE sources SET library_category_id = NULL WHERE id = ?1").bind(stored.id).run();
      }
    }
    let cursor = safeJson(connection.cursorJson);
    for (let page = 0; page < 20; page++) {
      const result = await connector.pullItems(connectorContext, cursor);
      if (!await selectionIsCurrent(connection, message, env)) { await releaseStaleSync(connection, env); return; }
      let itemFailure: unknown;
      for (const item of result.items) {
        try { await storeItem(connection, item, env, message.requestId); }
        catch (error) {
          itemFailure ??= error;
          await env.DB.prepare(`UPDATE sources SET sync_status = 'error', last_error_code = ?1, updated_at = ?2
            WHERE connection_id = ?3 AND external_id = ?4`)
            .bind(safeError(error), timestamp(), connection.id, item.sourceExternalId).run();
        }
      }
      if (itemFailure) throw itemFailure;
      cursor = result.cursor;
      if (!result.hasMore) break;
    }
    if (!await selectionIsCurrent(connection, message, env)) { await releaseStaleSync(connection, env); return; }
    await flushOutbox(connection, connectorContext, env);
    await syncRemoteStates(connection, connectorContext, env);
    const next = new Date(Date.now() + Math.max(1, Number.parseInt(env.FEED_INTERVAL_MINUTES, 10) || 15) * 60_000).toISOString();
    await env.DB.prepare(`UPDATE source_connections SET cursor_json = ?1, capabilities_json = ?2, status = 'ok',
      last_error_code = NULL, last_synced_at = ?3, next_sync_at = ?4, updated_at = ?3 WHERE id = ?5`)
      .bind(JSON.stringify(cursor), JSON.stringify(connector.capabilities), timestamp(), next, connection.id).run();
  } catch (error) {
    await env.DB.prepare(`UPDATE source_connections SET status = 'error', last_error_code = ?1,
      next_sync_at = ?2, updated_at = ?3 WHERE id = ?4`).bind(safeError(error), new Date(Date.now() + 300_000).toISOString(), timestamp(), connection.id).run();
    throw error;
  }
}
