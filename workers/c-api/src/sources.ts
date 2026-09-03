import type { AccessIdentity } from "../../shared/src/auth";
import { ensureAccount } from "../../shared/src/accounts";
import { decryptCredentials, encryptCredentials } from "../../shared/src/credentials";
import type { D1Database, Queue } from "../../shared/src/cloudflare";
import { ApiError, json } from "../../shared/src/http";
import { normalizeHttpUrl, readJsonObject, stringField } from "./validation";

export interface SourcesEnv {
  DB: D1Database;
  FEED_QUEUE: Queue<{ connectionId: string; sourceId?: string; selectionRevision?: number; requestId: string; reason: string } | {
    feedId: string; requestId: string; reason: string;
  } | {
    switchJobId: string; requestId: string; reason: "source_switch";
  }>;
  SOURCE_CREDENTIALS_KEY?: string;
  READER_CREDENTIALS_KEY?: string;
}

type ConnectorType = "direct_rss" | "google_reader";
type SyncPolicy = "feedmind_primary" | "upstream_primary" | "bidirectional";

const now = () => new Date().toISOString();
const capabilities = {
  direct_rss: { categories: true, incrementalCursor: true, readState: false, writeState: false },
  google_reader: { categories: true, incrementalCursor: true, readState: true, writeState: true },
} as const;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomSecret(bytes = 24): string {
  const value = new Uint8Array(bytes); crypto.getRandomValues(value); return base64Url(value);
}

async function secretHash(key: string, value: string): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value))));
}

async function ensureSelection(env: SourcesEnv, ownerId: string): Promise<{ connectionId: string; revision: number }> {
  const existing = await env.DB.prepare(`SELECT active_connection_id AS connectionId, revision
    FROM account_source_selections WHERE owner_id = ?1`).bind(ownerId).first<{ connectionId: string; revision: number }>();
  if (existing) return existing;
  const connectionId = `connection:direct-rss:${ownerId}`; const timestamp = now();
  await env.DB.prepare(`INSERT OR IGNORE INTO account_source_selections
    (owner_id, active_connection_id, revision, updated_at) VALUES (?1, ?2, 1, ?3)`)
    .bind(ownerId, connectionId, timestamp).run();
  return { connectionId, revision: 1 };
}

function parseObject(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "validation_failed", `${field} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" || item.length > 4096) throw new ApiError(422, "validation_failed", `${field}.${key} must be a string`);
    result[key] = item;
  }
  return result;
}

async function testGoogleReader(baseUrl: string, credentials: Record<string, string>): Promise<void> {
  if (!credentials.username?.trim() || !credentials.password) throw new ApiError(422, "credentials_required", "FreshRSS API username and password are required");
  const base = new URL(baseUrl); base.pathname = `${base.pathname.replace(/\/$/, "")}/accounts/ClientLogin`;
  const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: new URLSearchParams({ Email: credentials.username.trim(), Passwd: credentials.password }) });
  if (!response.ok) throw new ApiError(422, response.status === 401 || response.status === 403 ? "connection_auth_failed" : "connection_test_failed", "Unable to connect to the Google Reader API");
  if (!/^Auth=.+$/m.test(await response.text())) throw new ApiError(422, "connection_auth_invalid", "Google Reader API returned an invalid login response");
}

export async function activeConnection(env: SourcesEnv, ownerId: string): Promise<{ id: string; type: ConnectorType }> {
  const selection = await ensureSelection(env, ownerId);
  const row = await env.DB.prepare(`SELECT id, connector_type AS type FROM source_connections
    WHERE id = ?1 AND owner_id = ?2`).bind(selection.connectionId, ownerId).first<{ id: string; type: ConnectorType }>();
  if (!row) throw new ApiError(409, "active_connection_missing", "Active source connection is unavailable");
  return row;
}

async function googleReaderWrite(env: SourcesEnv, ownerId: string, connectionId: string, body: URLSearchParams): Promise<void> {
  const stored = await connectionCredentials(env, ownerId, connectionId);
  const base = new URL(stored.baseUrl); const root = base.pathname.replace(/\/$/, "");
  const login = new URL(base); login.pathname = `${root}/accounts/ClientLogin`;
  const loginResponse = await fetch(login, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: new URLSearchParams({ Email: stored.credentials.username ?? "", Passwd: stored.credentials.password ?? "" }) });
  const auth = (await loginResponse.text()).match(/^Auth=(.+)$/m)?.[1]?.trim();
  if (!loginResponse.ok || !auth) throw new ApiError(502, "connection_auth_failed", "External reader authentication failed");
  const tokenUrl = new URL(base); tokenUrl.pathname = `${root}/reader/api/0/token`;
  const tokenResponse = await fetch(tokenUrl, { headers: { Authorization: `GoogleLogin auth=${auth}` } });
  if (!tokenResponse.ok) throw new ApiError(502, "connection_write_failed", "External reader write token failed");
  body.set("T", (await tokenResponse.text()).trim());
  const editUrl = new URL(base); editUrl.pathname = `${root}/reader/api/0/subscription/edit`;
  const response = await fetch(editUrl, { method: "POST", headers: {
    Authorization: `GoogleLogin auth=${auth}`, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  }, body });
  if (!response.ok || (await response.text()).trim() !== "OK") throw new ApiError(502, "connection_write_failed", "External subscription update failed");
}

export async function createExternalSubscription(env: SourcesEnv, ownerId: string, connectionId: string,
  input: { url: string; title: string; category: string }, requestId: string): Promise<void> {
  const body = new URLSearchParams({ ac: "subscribe", s: `feed/${input.url}` });
  if (input.title) body.set("t", input.title);
  if (input.category) body.set("a", `user/-/label/${input.category}`);
  await googleReaderWrite(env, ownerId, connectionId, body);
  const selection = await ensureSelection(env, ownerId);
  await env.FEED_QUEUE.send({ connectionId, selectionRevision: selection.revision, requestId, reason: "subscription_created" }, { contentType: "json" });
}

export async function updateExternalSubscription(env: SourcesEnv, ownerId: string, connectionId: string, sourceId: string,
  input: { title: string; category: string; preserveOtherCategories?: boolean; removeCategories?: string[] }, requestId: string): Promise<void> {
  const source = await env.DB.prepare("SELECT external_id AS externalId FROM sources WHERE id = ?1 AND owner_id = ?2 AND connection_id = ?3")
    .bind(sourceId, ownerId, connectionId).first<{ externalId: string }>();
  if (!source) throw new ApiError(404, "not_found", "Subscription not found");
  const body = new URLSearchParams({ ac: "edit", s: source.externalId });
  if (input.title) body.set("t", input.title);
  const existing = await env.DB.prepare("SELECT name FROM source_categories WHERE source_id = ?1 ORDER BY sort_order, name")
    .bind(sourceId).all<{ name: string }>();
  for (const row of existing.results ?? []) {
    const remove = input.preserveOtherCategories
      ? (input.removeCategories ?? []).includes(row.name)
      : row.name !== input.category;
    if (remove) body.append("r", `user/-/label/${row.name}`);
  }
  if (input.category && !(existing.results ?? []).some((row) => row.name === input.category)) {
    body.append("a", `user/-/label/${input.category}`);
  }
  await googleReaderWrite(env, ownerId, connectionId, body);
  const selection = await ensureSelection(env, ownerId);
  await env.FEED_QUEUE.send({ connectionId, selectionRevision: selection.revision, requestId, reason: "subscription_updated" }, { contentType: "json" });
}

export async function deleteExternalSubscription(env: SourcesEnv, ownerId: string, connectionId: string,
  sourceId: string, requestId: string): Promise<void> {
  const source = await env.DB.prepare("SELECT external_id AS externalId FROM sources WHERE id = ?1 AND owner_id = ?2 AND connection_id = ?3")
    .bind(sourceId, ownerId, connectionId).first<{ externalId: string }>();
  if (!source) throw new ApiError(404, "not_found", "Subscription not found");
  await googleReaderWrite(env, ownerId, connectionId, new URLSearchParams({ ac: "unsubscribe", s: source.externalId }));
  await env.DB.prepare("UPDATE sources SET enabled = 0, sync_status = 'disabled', updated_at = ?1 WHERE id = ?2")
    .bind(now(), sourceId).run();
  const selection = await ensureSelection(env, ownerId);
  await env.FEED_QUEUE.send({ connectionId, selectionRevision: selection.revision, requestId, reason: "subscription_deleted" }, { contentType: "json" });
}

async function account(env: SourcesEnv, identity: AccessIdentity): Promise<string> {
  return ensureAccount(env.DB, identity);
}

async function listConnections(env: SourcesEnv, ownerId: string, requestId: string): Promise<Response> {
  const selection = await ensureSelection(env, ownerId);
  const result = await env.DB.prepare(`SELECT id, connector_type AS type, name, base_url AS baseUrl,
    sync_policy AS syncPolicy, capabilities_json AS capabilitiesJson, status, last_error_code AS lastErrorCode,
    last_synced_at AS lastSyncedAt, created_at AS createdAt, updated_at AS updatedAt
    FROM source_connections WHERE owner_id = ?1 ORDER BY created_at, id`).bind(ownerId).all<Record<string, unknown>>();
  return json({ items: (result.results ?? []).map((row) => ({ ...row, isActive: row.id === selection.connectionId,
    capabilities: JSON.parse(String(row.capabilitiesJson ?? "{}")), capabilitiesJson: undefined })), requestId }, requestId);
}

async function createConnection(request: Request, env: SourcesEnv, ownerId: string, requestId: string): Promise<Response> {
  const input = await readJsonObject(request);
  const type = stringField(input.type, "type", 40, true) as ConnectorType;
  if (!(type in capabilities)) throw new ApiError(422, "validation_failed", "Unsupported connector type");
  const name = stringField(input.name, "name", 200, true);
  const baseUrl = type === "google_reader" ? normalizeHttpUrl(input.baseUrl, "baseUrl").replace(/\/$/, "") : null;
  const credentials = parseObject(input.credentials ?? {}, "credentials");
  const requestedPolicy = (input.syncPolicy ?? (type === "google_reader" ? "bidirectional" : "feedmind_primary")) as SyncPolicy;
  if (!["feedmind_primary", "upstream_primary", "bidirectional"].includes(requestedPolicy)) throw new ApiError(422, "validation_failed", "Invalid sync policy");
  const syncPolicy = capabilities[type].writeState ? requestedPolicy : "feedmind_primary";
  if (type === "google_reader") await testGoogleReader(baseUrl!, credentials);
  if (!env.SOURCE_CREDENTIALS_KEY) throw new ApiError(503, "credentials_key_unavailable", "Source credentials encryption is not configured");
  const encrypted = Object.keys(credentials).length ? await encryptCredentials(env.SOURCE_CREDENTIALS_KEY, credentials) : null;
  const id = crypto.randomUUID(); const created = now();
  try {
    await env.DB.prepare(`INSERT INTO source_connections
      (id, owner_id, connector_type, name, base_url, credentials_encrypted, sync_policy, capabilities_json,
       cursor_json, status, next_sync_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '{}', 'pending', ?9, ?9, ?9)`)
      .bind(id, ownerId, type, name, baseUrl, encrypted, syncPolicy, JSON.stringify(capabilities[type]), created).run();
  } catch { throw new ApiError(409, "connection_exists", "This source connection already exists"); }
  if (type !== "direct_rss") {
    const selection = await ensureSelection(env, ownerId);
    await env.FEED_QUEUE.send({ connectionId: id, selectionRevision: selection.revision, requestId, reason: "connection_created" }, { contentType: "json" });
  }
  return json({ data: { id, type, name, baseUrl, syncPolicy, capabilities: capabilities[type], status: "pending" }, requestId }, requestId, 201);
}

async function connectionCredentials(env: SourcesEnv, ownerId: string, id: string): Promise<{ baseUrl: string; credentials: Record<string, string> }> {
  const row = await env.DB.prepare(`SELECT base_url AS baseUrl, credentials_encrypted AS encrypted FROM source_connections
    WHERE id = ?1 AND owner_id = ?2`).bind(id, ownerId).first<{ baseUrl: string; encrypted: string | null }>();
  if (!row) throw new ApiError(404, "not_found", "Connection not found");
  if (!env.SOURCE_CREDENTIALS_KEY || !row.encrypted) throw new ApiError(503, "credentials_unavailable", "Connection credentials are unavailable");
  return { baseUrl: row.baseUrl, credentials: await decryptCredentials(env.SOURCE_CREDENTIALS_KEY, row.encrypted) };
}

async function patchConnection(request: Request, env: SourcesEnv, ownerId: string, id: string): Promise<Response> {
  const input = await readJsonObject(request); const updated = now();
  const current = await env.DB.prepare(`SELECT connector_type AS type, name, base_url AS baseUrl, credentials_encrypted AS encrypted,
    sync_policy AS syncPolicy FROM source_connections WHERE id = ?1 AND owner_id = ?2`).bind(id, ownerId)
    .first<{ type: ConnectorType; name: string; baseUrl: string | null; encrypted: string | null; syncPolicy: SyncPolicy }>();
  if (!current) throw new ApiError(404, "not_found", "Connection not found");
  const name = input.name === undefined ? current.name : stringField(input.name, "name", 200, true);
  const baseUrl = input.baseUrl === undefined ? current.baseUrl : normalizeHttpUrl(input.baseUrl, "baseUrl").replace(/\/$/, "");
  const policy = input.syncPolicy === undefined ? current.syncPolicy : String(input.syncPolicy) as SyncPolicy;
  if (!["feedmind_primary", "upstream_primary", "bidirectional"].includes(policy)) throw new ApiError(422, "validation_failed", "Invalid sync policy");
  let encrypted = current.encrypted;
  if (input.credentials !== undefined) {
    if (!env.SOURCE_CREDENTIALS_KEY) throw new ApiError(503, "credentials_key_unavailable", "Source credentials encryption is not configured");
    encrypted = await encryptCredentials(env.SOURCE_CREDENTIALS_KEY, parseObject(input.credentials, "credentials"));
  }
  await env.DB.prepare(`UPDATE source_connections SET name = ?1, base_url = ?2, credentials_encrypted = ?3,
    sync_policy = ?4, status = 'pending', last_error_code = NULL, next_sync_at = ?5, updated_at = ?5 WHERE id = ?6 AND owner_id = ?7`)
    .bind(name, baseUrl, encrypted, capabilities[current.type].writeState ? policy : "feedmind_primary", updated, id, ownerId).run();
  return new Response(null, { status: 204 });
}

async function deleteConnection(env: SourcesEnv, ownerId: string, id: string): Promise<Response> {
  const selection = await ensureSelection(env, ownerId);
  if (selection.connectionId === id) throw new ApiError(409, "active_connection", "Switch to another source before deleting this connection");
  const result = await env.DB.prepare("DELETE FROM source_connections WHERE id = ?1 AND owner_id = ?2 AND connector_type <> 'direct_rss'").bind(id, ownerId).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new ApiError(404, "not_found", "Connection not found or cannot be deleted");
  return new Response(null, { status: 204 });
}

async function sourceSelection(request: Request, env: SourcesEnv, ownerId: string, requestId: string): Promise<Response> {
  const current = await ensureSelection(env, ownerId);
  if (request.method === "GET") {
    const connection = await env.DB.prepare(`SELECT id, connector_type AS type, name, status
      FROM source_connections WHERE id = ?1 AND owner_id = ?2`).bind(current.connectionId, ownerId).first();
    const job = await env.DB.prepare(`SELECT id, from_connection_id AS fromConnectionId, to_connection_id AS toConnectionId,
      status, total_count AS totalCount, succeeded_count AS succeededCount, failed_count AS failedCount,
      skipped_count AS skippedCount, last_error_code AS lastErrorCode, created_at AS createdAt, updated_at AS updatedAt
      FROM source_switch_jobs WHERE owner_id = ?1 ORDER BY created_at DESC LIMIT 1`).bind(ownerId).first();
    return json({ data: { connection, revision: current.revision, job }, requestId }, requestId);
  }
  const input = await readJsonObject(request);
  const connectionId = stringField(input.connectionId, "connectionId", 200, true);
  const migrate = input.migrateToTarget === true;
  const target = await env.DB.prepare("SELECT id, connector_type AS type FROM source_connections WHERE id = ?1 AND owner_id = ?2")
    .bind(connectionId, ownerId).first<{ id: string; type: ConnectorType }>();
  if (!target) throw new ApiError(404, "not_found", "Source connection not found");
  if (connectionId === current.connectionId) return json({ data: { connectionId, revision: current.revision, jobId: null }, requestId }, requestId);
  const timestamp = now(); const revision = Number(current.revision) + 1; const jobId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE account_source_selections SET active_connection_id = ?1, revision = ?2, updated_at = ?3
      WHERE owner_id = ?4 AND revision = ?5`).bind(connectionId, revision, timestamp, ownerId, current.revision),
    env.DB.prepare(`INSERT INTO source_switch_jobs
      (id, owner_id, from_connection_id, to_connection_id, selection_revision, migrate_to_target,
       status, created_at, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7
      WHERE EXISTS (SELECT 1 FROM account_source_selections WHERE owner_id = ?2 AND active_connection_id = ?4 AND revision = ?5)`)
      .bind(jobId, ownerId, current.connectionId, connectionId, revision, migrate ? 1 : 0, timestamp),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new ApiError(409, "source_selection_conflict", "Source selection changed concurrently; retry the request");
  }
  await env.FEED_QUEUE.send({ switchJobId: jobId, requestId, reason: "source_switch" }, { contentType: "json" });
  return json({ data: { connectionId, revision, jobId }, requestId }, requestId, 202);
}

async function switchJob(request: Request, env: SourcesEnv, ownerId: string, id: string, requestId: string, retry: boolean): Promise<Response> {
  const job = await env.DB.prepare(`SELECT id, from_connection_id AS fromConnectionId, to_connection_id AS toConnectionId,
    selection_revision AS selectionRevision, status, total_count AS totalCount, succeeded_count AS succeededCount,
    failed_count AS failedCount, skipped_count AS skippedCount, last_error_code AS lastErrorCode,
    created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt, updated_at AS updatedAt
    FROM source_switch_jobs WHERE id = ?1 AND owner_id = ?2`).bind(id, ownerId).first<Record<string, unknown>>();
  if (!job) throw new ApiError(404, "not_found", "Source switch job not found");
  if (!retry) return json({ data: job, requestId }, requestId);
  if (!['partial', 'failed'].includes(String(job.status))) {
    throw new ApiError(409, "no_failed_items", "This source switch job has no failed work to retry");
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE source_switch_job_items SET status = 'pending', last_error_code = NULL, updated_at = ?1 WHERE job_id = ?2 AND status = 'failed'").bind(now(), id),
    env.DB.prepare("UPDATE source_switch_jobs SET status = 'pending', failed_count = 0, last_error_code = NULL, completed_at = NULL, updated_at = ?1 WHERE id = ?2").bind(now(), id),
  ]);
  await env.FEED_QUEUE.send({ switchJobId: id, requestId, reason: "source_switch" }, { contentType: "json" });
  return json({ data: { id, status: "pending" }, requestId }, requestId, 202);
}

async function readerCredentials(request: Request, env: SourcesEnv, ownerId: string, requestId: string): Promise<Response> {
  if (!env.READER_CREDENTIALS_KEY) throw new ApiError(503, "reader_credentials_unavailable", "Reader credential hashing is not configured");
  if (request.method === "GET") {
    const login = await env.DB.prepare("SELECT normalized_email AS loginName FROM accounts WHERE id = ?1").bind(ownerId).first<{ loginName: string | null }>();
    const result = await env.DB.prepare(`SELECT id, name, login_name AS loginName, created_at AS createdAt,
      last_used_at AS lastUsedAt FROM reader_api_credentials WHERE owner_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC`)
      .bind(ownerId).all();
    return json({ items: result.results ?? [], loginName: login?.loginName ?? "", requestId }, requestId);
  }
  const input = await readJsonObject(request); const name = stringField(input.name, "name", 100, true);
  const account = await env.DB.prepare("SELECT normalized_email AS loginName FROM accounts WHERE id = ?1")
    .bind(ownerId).first<{ loginName: string | null }>();
  if (!account?.loginName) throw new ApiError(409, "verified_email_required", "A verified account email is required");
  const id = crypto.randomUUID(); const secret = `fm_${id.slice(0, 8)}_${randomSecret()}`; const timestamp = now();
  await env.DB.prepare(`INSERT INTO reader_api_credentials
    (id, owner_id, name, login_name, secret_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(id, ownerId, name, account.loginName, await secretHash(env.READER_CREDENTIALS_KEY, secret), timestamp).run();
  return json({ data: { id, name, loginName: account.loginName, appPassword: secret, createdAt: timestamp }, requestId }, requestId, 201);
}

async function revokeReaderCredential(env: SourcesEnv, ownerId: string, id: string): Promise<Response> {
  const timestamp = now();
  const result = await env.DB.prepare(`UPDATE reader_api_credentials SET revoked_at = ?1
    WHERE id = ?2 AND owner_id = ?3 AND revoked_at IS NULL`).bind(timestamp, id, ownerId).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new ApiError(404, "not_found", "Reader credential not found");
  await env.DB.prepare("UPDATE reader_api_sessions SET revoked_at = ?1 WHERE credential_id = ?2 AND revoked_at IS NULL").bind(timestamp, id).run();
  return new Response(null, { status: 204 });
}

async function listSources(request: Request, env: SourcesEnv, ownerId: string, requestId: string): Promise<Response> {
  const url = new URL(request.url); const connectionId = url.searchParams.get("connectionId") ?? "";
  const result = await env.DB.prepare(`SELECT s.id, s.connection_id AS connectionId, s.kind, s.title, s.url, s.site_url AS siteUrl,
    s.enabled, s.sync_status AS syncStatus, s.last_error_code AS lastErrorCode, s.last_synced_at AS lastSyncedAt,
    s.created_at AS createdAt, s.updated_at AS updatedAt,
    (SELECT json_group_array(name) FROM source_categories c WHERE c.source_id = s.id ORDER BY sort_order) AS categoriesJson,
    (SELECT COUNT(*) FROM source_items i WHERE i.source_id = s.id) AS articleCount
    FROM sources s WHERE s.owner_id = ?1 AND (?2 = '' OR s.connection_id = ?2) ORDER BY lower(s.title), s.id`)
    .bind(ownerId, connectionId).all<Record<string, unknown>>();
  return json({ items: (result.results ?? []).map((row) => ({ ...row, enabled: row.enabled === 1,
    categories: JSON.parse(String(row.categoriesJson ?? "[]")), categoriesJson: undefined })), requestId }, requestId);
}

async function patchSource(request: Request, env: SourcesEnv, ownerId: string, id: string): Promise<Response> {
  const input = await readJsonObject(request);
  if (typeof input.enabled !== "boolean") throw new ApiError(422, "validation_failed", "enabled must be a boolean");
  if (!Array.isArray(input.categories) || input.categories.length > 50) throw new ApiError(422, "validation_failed", "categories must be an array");
  const categories = [...new Set(input.categories.map((value) => stringField(value, "category", 200, true)))];
  const source = await env.DB.prepare("SELECT id FROM sources WHERE id = ?1 AND owner_id = ?2").bind(id, ownerId).first();
  if (!source) throw new ApiError(404, "not_found", "Source not found");
  const statements = [
    env.DB.prepare("UPDATE sources SET enabled = ?1, sync_status = ?2, updated_at = ?3 WHERE id = ?4 AND owner_id = ?5")
      .bind(input.enabled ? 1 : 0, input.enabled ? "pending" : "disabled", now(), id, ownerId),
    env.DB.prepare("DELETE FROM source_categories WHERE source_id = ?1").bind(id),
    ...categories.map((category, index) => env.DB.prepare("INSERT INTO source_categories(source_id, name, sort_order) VALUES (?1, ?2, ?3)").bind(id, category, index)),
  ];
  await env.DB.batch(statements);
  return new Response(null, { status: 204 });
}

export async function routeSources(request: Request, env: SourcesEnv, requestId: string, identity: AccessIdentity,
  resolvedAccountId?: string): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/v1/connections") && !path.startsWith("/v1/sources")
    && !path.startsWith("/v1/source-selection") && !path.startsWith("/v1/source-switch-jobs")
    && !path.startsWith("/v1/reader-credentials")) return undefined;
  const ownerId = resolvedAccountId ?? await account(env, identity);
  if (path === "/v1/source-selection" && (request.method === "GET" || request.method === "PUT")) {
    return sourceSelection(request, env, ownerId, requestId);
  }
  const job = path.match(/^\/v1\/source-switch-jobs\/([^/]+)(?:\/(retry))?$/);
  if (job && ((request.method === "GET" && !job[2]) || (request.method === "POST" && job[2] === "retry"))) {
    return switchJob(request, env, ownerId, decodeURIComponent(job[1]), requestId, job[2] === "retry");
  }
  if (path === "/v1/reader-credentials" && (request.method === "GET" || request.method === "POST")) {
    return readerCredentials(request, env, ownerId, requestId);
  }
  const credential = path.match(/^\/v1\/reader-credentials\/([^/]+)$/);
  if (credential && request.method === "DELETE") return revokeReaderCredential(env, ownerId, decodeURIComponent(credential[1]));
  if (path === "/v1/connections") {
    if (request.method === "GET") return listConnections(env, ownerId, requestId);
    if (request.method === "POST") return createConnection(request, env, ownerId, requestId);
  }
  const connection = path.match(/^\/v1\/connections\/([^/]+)(?:\/(test|sync))?$/);
  if (connection) {
    const id = decodeURIComponent(connection[1]);
    if (!connection[2] && request.method === "PATCH") return patchConnection(request, env, ownerId, id);
    if (!connection[2] && request.method === "DELETE") return deleteConnection(env, ownerId, id);
    if (connection[2] === "test" && request.method === "POST") {
      const stored = await connectionCredentials(env, ownerId, id); await testGoogleReader(stored.baseUrl, stored.credentials);
      return json({ data: { ok: true }, requestId }, requestId);
    }
    if (connection[2] === "sync" && request.method === "POST") {
      const exists = await env.DB.prepare("SELECT id FROM source_connections WHERE id = ?1 AND owner_id = ?2").bind(id, ownerId).first();
      if (!exists) throw new ApiError(404, "not_found", "Connection not found");
      const selection = await ensureSelection(env, ownerId);
      if (selection.connectionId !== id) throw new ApiError(409, "inactive_connection", "Switch to this source before syncing it");
      await env.DB.prepare("UPDATE source_connections SET status = 'pending', next_sync_at = ?1, updated_at = ?1 WHERE id = ?2").bind(now(), id).run();
      await env.FEED_QUEUE.send({ connectionId: id, selectionRevision: selection.revision, requestId, reason: "manual_sync" }, { contentType: "json" });
      return json({ data: { status: "queued" }, requestId }, requestId, 202);
    }
  }
  if (path === "/v1/sources" && request.method === "GET") return listSources(request, env, ownerId, requestId);
  const source = path.match(/^\/v1\/sources\/([^/]+)$/);
  if (source && request.method === "PATCH") return patchSource(request, env, ownerId, decodeURIComponent(source[1]));
  return undefined;
}
