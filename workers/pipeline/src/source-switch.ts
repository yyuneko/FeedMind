import { decryptCredentials } from "../../shared/src/credentials";
import type { D1Database } from "../../shared/src/cloudflare";
import { connectorFor, type ConnectorContext, type ConnectorType } from "./connectors";
import { processSourceSync, type SourceSyncEnv } from "./source-sync";

export interface SourceSwitchMessage { switchJobId: string; requestId: string; reason: "source_switch" }

interface JobRow {
  id: string; ownerId: string; fromConnectionId: string; toConnectionId: string;
  selectionRevision: number; migrate: number; status: string;
}

interface ConnectionRow { id: string; type: ConnectorType; baseUrl: string | null; encrypted: string | null }

const now = () => new Date().toISOString();
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 100);

async function connectorContext(connection: ConnectionRow, env: SourceSyncEnv): Promise<ConnectorContext> {
  return { baseUrl: connection.baseUrl ?? "", credentials: connection.encrypted
    ? await decryptCredentials(env.SOURCE_CREDENTIALS_KEY, connection.encrypted) : {} };
}

async function seedSubscriptions(db: D1Database, job: JobRow): Promise<void> {
  const result = await db.prepare(`SELECT source.id, source.url, COALESCE(NULLIF(source.custom_title, ''), source.title) AS title,
    COALESCE((SELECT json_group_array(name) FROM source_categories category WHERE category.source_id = source.id), '[]') AS categoriesJson
    FROM sources source WHERE source.owner_id = ?1 AND source.connection_id = ?2 AND source.enabled = 1 AND source.url IS NOT NULL`)
    .bind(job.ownerId, job.fromConnectionId).all<{ id: string; url: string; title: string; categoriesJson: string }>();
  const timestamp = now();
  for (const source of result.results ?? []) {
    await db.prepare(`INSERT OR IGNORE INTO source_switch_job_items
      (id, job_id, item_type, source_key, payload_json, status, created_at, updated_at)
      VALUES (?1, ?2, 'subscription', ?3, ?4, 'pending', ?5, ?5)`)
      .bind(crypto.randomUUID(), job.id, source.url, JSON.stringify({ url: source.url, title: source.title,
        categories: JSON.parse(source.categoriesJson || "[]") }), timestamp).run();
  }
}

async function migrateSubscriptions(db: D1Database, job: JobRow, connection: ConnectionRow,
  context: ConnectorContext): Promise<void> {
  const items = await db.prepare(`SELECT id, payload_json AS payloadJson FROM source_switch_job_items
    WHERE job_id = ?1 AND item_type = 'subscription' AND status IN ('pending','failed') ORDER BY created_at`)
    .bind(job.id).all<{ id: string; payloadJson: string }>();
  for (const item of items.results ?? []) {
    const payload = JSON.parse(item.payloadJson) as { url: string; title: string; categories: string[] };
    try {
      await connectorFor(connection.type).pushSubscriptions(context, [{ action: "subscribe", ...payload }]);
      await db.prepare("UPDATE source_switch_job_items SET status = 'completed', attempt_count = attempt_count + 1, last_error_code = NULL, updated_at = ?1 WHERE id = ?2")
        .bind(now(), item.id).run();
    } catch (error) {
      await db.prepare("UPDATE source_switch_job_items SET status = 'failed', attempt_count = attempt_count + 1, last_error_code = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(safeError(error), now(), item.id).run();
    }
  }
}

async function seedStates(db: D1Database, job: JobRow): Promise<void> {
  const states = await db.prepare(`SELECT state.article_id AS articleId, state.is_read AS isRead, state.is_saved AS isSaved,
    target.external_item_id AS externalItemId
    FROM article_states state LEFT JOIN source_items target
      ON target.connection_id = ?1 AND target.article_id = state.article_id
    WHERE state.owner_id = ?2 AND state.connection_id = ?3 AND (state.is_read = 1 OR state.is_saved = 1)`)
    .bind(job.toConnectionId, job.ownerId, job.fromConnectionId)
    .all<{ articleId: string; isRead: number; isSaved: number; externalItemId: string | null }>();
  const timestamp = now();
  for (const state of states.results ?? []) {
    const status = state.externalItemId ? "pending" : "skipped";
    await db.prepare(`INSERT OR IGNORE INTO source_switch_job_items
      (id, job_id, item_type, source_key, payload_json, status, created_at, updated_at)
      VALUES (?1, ?2, 'article_state', ?3, ?4, ?5, ?6, ?6)`)
      .bind(crypto.randomUUID(), job.id, state.articleId, JSON.stringify(state), status, timestamp).run();
  }
}

async function migrateStates(db: D1Database, job: JobRow, connection: ConnectionRow,
  context: ConnectorContext): Promise<void> {
  const items = await db.prepare(`SELECT id, payload_json AS payloadJson FROM source_switch_job_items
    WHERE job_id = ?1 AND item_type = 'article_state' AND status IN ('pending','failed') ORDER BY created_at`)
    .bind(job.id).all<{ id: string; payloadJson: string }>();
  for (const item of items.results ?? []) {
    const state = JSON.parse(item.payloadJson) as { externalItemId: string; isRead: number; isSaved: number };
    try {
      await connectorFor(connection.type).pushStates(context, [{ externalItemId: state.externalItemId,
        ...(state.isRead ? { isRead: true } : {}), ...(state.isSaved ? { isSaved: true } : {}) }]);
      await db.prepare("UPDATE source_switch_job_items SET status = 'completed', attempt_count = attempt_count + 1, last_error_code = NULL, updated_at = ?1 WHERE id = ?2")
        .bind(now(), item.id).run();
    } catch (error) {
      await db.prepare("UPDATE source_switch_job_items SET status = 'failed', attempt_count = attempt_count + 1, last_error_code = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(safeError(error), now(), item.id).run();
    }
  }
}

async function finish(db: D1Database, jobId: string): Promise<void> {
  const counts = await db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS succeeded,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
    FROM source_switch_job_items WHERE job_id = ?1`).bind(jobId)
    .first<{ total: number; succeeded: number; failed: number; skipped: number }>();
  const failed = Number(counts?.failed ?? 0); const timestamp = now();
  await db.prepare(`UPDATE source_switch_jobs SET status = ?1, total_count = ?2, succeeded_count = ?3,
    failed_count = ?4, skipped_count = ?5, completed_at = ?6, updated_at = ?6 WHERE id = ?7`)
    .bind(failed ? "partial" : "completed", Number(counts?.total ?? 0), Number(counts?.succeeded ?? 0),
      failed, Number(counts?.skipped ?? 0), timestamp, jobId).run();
}

async function remainsSelected(db: D1Database, job: JobRow): Promise<boolean> {
  const selected = await db.prepare(`SELECT active_connection_id AS connectionId, revision
    FROM account_source_selections WHERE owner_id = ?1`).bind(job.ownerId)
    .first<{ connectionId: string; revision: number }>();
  if (selected?.connectionId === job.toConnectionId && Number(selected.revision) === Number(job.selectionRevision)) return true;
  await db.prepare("UPDATE source_switch_jobs SET status = 'superseded', completed_at = ?1, updated_at = ?1 WHERE id = ?2")
    .bind(now(), job.id).run();
  return false;
}

export async function processSourceSwitch(message: SourceSwitchMessage, env: SourceSyncEnv): Promise<void> {
  const job = await env.DB.prepare(`SELECT id, owner_id AS ownerId, from_connection_id AS fromConnectionId,
    to_connection_id AS toConnectionId, selection_revision AS selectionRevision,
    migrate_to_target AS migrate, status FROM source_switch_jobs WHERE id = ?1`)
    .bind(message.switchJobId).first<JobRow>();
  if (!job || !["pending", "partial", "failed"].includes(job.status)) return;
  if (!await remainsSelected(env.DB, job)) return;
  await env.DB.prepare("UPDATE source_switch_jobs SET status = 'running', started_at = COALESCE(started_at, ?1), updated_at = ?1 WHERE id = ?2")
    .bind(now(), job.id).run();
  const target = await env.DB.prepare(`SELECT id, connector_type AS type, base_url AS baseUrl,
    credentials_encrypted AS encrypted FROM source_connections WHERE id = ?1 AND owner_id = ?2`)
    .bind(job.toConnectionId, job.ownerId).first<ConnectionRow>();
  try {
    if (!target || target.type === "direct_rss") { await finish(env.DB, job.id); return; }
    const context = await connectorContext(target, env);
    if (job.migrate) {
      await seedSubscriptions(env.DB, job);
      await migrateSubscriptions(env.DB, job, target, context);
    }
    if (!await remainsSelected(env.DB, job)) return;
    await processSourceSync({ connectionId: target.id, selectionRevision: job.selectionRevision,
      requestId: message.requestId, reason: "source_switch" }, env);
    if (!await remainsSelected(env.DB, job)) return;
    if (job.migrate) {
      await seedStates(env.DB, job);
      await migrateStates(env.DB, job, target, context);
    }
    if (!await remainsSelected(env.DB, job)) return;
    await finish(env.DB, job.id);
  } catch (error) {
    await env.DB.prepare("UPDATE source_switch_jobs SET status = 'failed', last_error_code = ?1, completed_at = ?2, updated_at = ?2 WHERE id = ?3")
      .bind(safeError(error), now(), job.id).run();
    throw error;
  }
}
