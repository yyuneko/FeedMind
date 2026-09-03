import type { D1Database } from "../../shared/src/cloudflare";
import { ApiError, json } from "../../shared/src/http";
import { readJsonObject, stringField } from "./validation";
import { REQUEST_OWNER } from "../../shared/src/scoped-db";

interface Env { DB: D1Database }
const OWNER = REQUEST_OWNER;
const timestamp = () => new Date().toISOString();

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "validation_failed", `${field} must be an object`);
  return value as Record<string, unknown>;
}

function number(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new ApiError(422, "validation_failed", `${field} is invalid`);
  return value;
}

function parseJson(value: unknown, fallback: unknown): unknown {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

function preferences(row: { settingsJson?: string } | null) {
  const stored = parseJson(row?.settingsJson, {}) as Record<string, unknown>;
  return {
    languageMode: stored.languageMode ?? "system", themeMode: stored.themeMode ?? "system",
    fontSize: Number(stored.fontSize ?? 17), lineHeightRatio: Number(stored.lineHeightRatio ?? 1.7), version: Number(stored.version ?? 1),
  };
}

async function preferencesRoute(request: Request, env: Env, requestId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT settings_json AS settingsJson FROM preferences WHERE owner_id = ?1").bind(OWNER).first<{ settingsJson: string }>();
  const current = preferences(row);
  if (request.method === "GET") return json({ items: [current], requestId }, requestId);
  const input = await readJsonObject(request);
  const expectedVersion = number(input.Version, "Version", 1, Number.MAX_SAFE_INTEGER);
  if (current.version !== expectedVersion) throw new ApiError(409, "version_conflict", "Preferences were changed by another client");
  const languageMode = stringField(input.LanguageMode, "LanguageMode", 20, true);
  const themeMode = stringField(input.ThemeMode, "ThemeMode", 20, true);
  if (!['system','zh','en','ja'].includes(languageMode) || !['system','light','dark'].includes(themeMode)) throw new ApiError(422, "validation_failed", "Preference enum is invalid");
  const next = { languageMode, themeMode, fontSize: number(input.FontSize, "FontSize", 10, 42),
    lineHeightRatio: number(input.LineHeightRatio, "LineHeightRatio", 1, 3), version: current.version + 1 };
  await env.DB.prepare(`INSERT INTO preferences (owner_id, locale, target_locale, settings_json, updated_at)
    VALUES (?1, ?2, 'zh-CN', ?3, ?4) ON CONFLICT(owner_id) DO UPDATE SET locale = excluded.locale,
    settings_json = excluded.settings_json, updated_at = excluded.updated_at`).bind(OWNER, languageMode, JSON.stringify(next), timestamp()).run();
  return json({ items: [next], requestId }, requestId);
}

interface SessionRow extends Record<string, unknown> {
  id: string; articleId: string; articleContentHash: string; status: string; stage: string; completedRounds: number;
  coverageJson: string; coachStateJson: string; reportJson: string | null; version: number; startedAt: string;
  completedAt: string | null; updatedAt: string | null;
}

function session(row: SessionRow, events?: unknown[]) {
  return { id: row.id, articleId: row.articleId, articleContentHash: row.articleContentHash, status: row.status,
    stage: row.stage, completedRounds: Number(row.completedRounds), coverage: parseJson(row.coverageJson, {}),
    coachState: parseJson(row.coachStateJson, {}), report: row.reportJson ? parseJson(row.reportJson, null) : null,
    version: Number(row.version), startedAt: row.startedAt, completedAt: row.completedAt, updatedAt: row.updatedAt ?? row.startedAt,
    ...(events ? { events } : {}) };
}

const selectSession = `SELECT id, article_id AS articleId, article_content_hash AS articleContentHash, status, stage,
  completed_rounds AS completedRounds, coverage_json AS coverageJson, coach_state_json AS coachStateJson,
  report_json AS reportJson, version, created_at AS startedAt, completed_at AS completedAt, updated_at AS updatedAt FROM thinking_sessions`;

async function assertActiveArticle(env: Env, articleId: string): Promise<void> {
  const article = await env.DB.prepare(`SELECT article.id FROM articles article
    WHERE article.id = ?1 AND EXISTS (SELECT 1 FROM source_items item
      JOIN sources source ON source.id = item.source_id AND source.enabled = 1
      JOIN account_source_selections selection ON selection.owner_id = item.owner_id
        AND selection.active_connection_id = item.connection_id
      WHERE item.owner_id = ?2 AND item.article_id = article.id)`).bind(articleId, OWNER).first();
  if (!article) throw new ApiError(404, "not_found", "Article not found");
}

async function assertActiveSession(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare("SELECT article_id AS articleId FROM thinking_sessions WHERE id = ?1 AND owner_id = ?2")
    .bind(id, OWNER).first<{ articleId: string }>();
  if (!row) throw new ApiError(404, "not_found", "Thinking session not found");
  await assertActiveArticle(env, row.articleId);
}

async function listSessions(env: Env, articleId: string, requestId: string): Promise<Response> {
  await assertActiveArticle(env, articleId);
  const result = await env.DB.prepare(`${selectSession} WHERE owner_id = ?1 AND article_id = ?2 ORDER BY created_at DESC LIMIT 100`).bind(OWNER, articleId).all<SessionRow>();
  return json({ items: (result.results ?? []).map((row) => session(row)), requestId }, requestId);
}

async function createSession(request: Request, env: Env, articleId: string, requestId: string): Promise<Response> {
  await assertActiveArticle(env, articleId);
  const input = await readJsonObject(request);
  const hash = stringField(input.articleContentHash, "articleContentHash", 128, true);
  const existing = await env.DB.prepare(`${selectSession} WHERE owner_id = ?1 AND article_id = ?2 AND article_content_hash = ?3 AND status = 'active' LIMIT 1`)
    .bind(OWNER, articleId, hash).first<SessionRow>();
  if (existing) return json({ session: session(existing), created: false, requestId }, requestId);
  const id = crypto.randomUUID(); const created = timestamp();
  await env.DB.prepare(`INSERT INTO thinking_sessions
    (id, owner_id, article_id, article_content_hash, status, stage, completed_rounds, coverage_json, coach_state_json, version, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'active', 'summary', 0, '{}', '{}', 1, ?5, ?5)`).bind(id, OWNER, articleId, hash, created).run();
  const row = await env.DB.prepare(`${selectSession} WHERE id = ?1`).bind(id).first<SessionRow>();
  return json({ session: session(row!), created: true, requestId }, requestId, 201);
}

async function getSession(env: Env, id: string, requestId: string): Promise<Response> {
  await assertActiveSession(env, id);
  const row = await env.DB.prepare(`${selectSession} WHERE id = ?1 AND owner_id = ?2`).bind(id, OWNER).first<SessionRow>();
  if (!row) throw new ApiError(404, "not_found", "Thinking session not found");
  const result = await env.DB.prepare(`SELECT id, sequence, event_type AS kind, payload_json AS payloadJson, created_at AS createdAt
    FROM thinking_events WHERE session_id = ?1 ORDER BY sequence`).bind(id).all<Record<string, unknown>>();
  const events = (result.results ?? []).map((event) => { const payload = parseJson(event.payloadJson, {}) as Record<string, unknown>;
    return { id: event.id, sequence: Number(event.sequence), kind: event.kind, content: String(payload.content ?? ''), metadata: payload.metadata ?? {}, createdAt: event.createdAt }; });
  return json(session(row, events), requestId);
}

async function appendEvents(request: Request, env: Env, id: string, requestId: string): Promise<Response> {
  await assertActiveSession(env, id);
  const input = await readJsonObject(request, 100_000);
  const expectedVersion = number(input.expectedVersion, "expectedVersion", 1, Number.MAX_SAFE_INTEGER);
  const current = await env.DB.prepare("SELECT version, status FROM thinking_sessions WHERE id = ?1 AND owner_id = ?2").bind(id, OWNER).first<{ version: number; status: string }>();
  if (!current) throw new ApiError(404, "not_found", "Thinking session not found");
  if (current.status !== 'active') throw new ApiError(409, "session_not_active", "Thinking session is not active");
  if (Number(current.version) !== expectedVersion) throw new ApiError(409, "version_conflict", "Thinking session was changed by another client");
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 20) throw new ApiError(422, "validation_failed", "events must contain 1 to 20 entries");
  const maximum = await env.DB.prepare("SELECT COALESCE(MAX(sequence), -1) AS sequence FROM thinking_events WHERE session_id = ?1").bind(id).first<{ sequence: number }>();
  const created = timestamp();
  const statements = input.events.map((raw, index) => { const event = object(raw, "event");
    const kind = stringField(event.kind, "kind", 30, true); const content = stringField(event.content, "content", 20_000, true);
    if (!['question','answer','feedback','hint','explanation'].includes(kind)) throw new ApiError(422, "validation_failed", "event kind is invalid");
    return env.DB.prepare(`INSERT INTO thinking_events (id, session_id, sequence, event_type, payload_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(crypto.randomUUID(), id, Number(maximum?.sequence ?? -1) + index + 1, kind,
        JSON.stringify({ content, metadata: event.metadata && typeof event.metadata === 'object' ? event.metadata : {} }), created); });
  const status = stringField(input.status, "status", 20, true);
  if (!['active','completed'].includes(status)) throw new ApiError(422, "validation_failed", "status is invalid");
  statements.push(env.DB.prepare(`UPDATE thinking_sessions SET status = ?1, stage = ?2, completed_rounds = ?3,
    coverage_json = ?4, coach_state_json = ?5, report_json = ?6, version = version + 1, completed_at = ?7, updated_at = ?8
    WHERE id = ?9 AND version = ?10`).bind(status, stringField(input.stage, "stage", 40, true),
      number(input.completedRounds, "completedRounds", 0, 1000), JSON.stringify(object(input.coverage, "coverage")),
      JSON.stringify(object(input.coachState, "coachState")), input.report == null ? null : JSON.stringify(object(input.report, "report")),
      status === 'completed' ? created : null, created, id, expectedVersion));
  await env.DB.batch(statements);
  return getSession(env, id, requestId);
}

async function abandon(request: Request, env: Env, id: string, requestId: string): Promise<Response> {
  await assertActiveSession(env, id);
  const input = await readJsonObject(request); const version = number(input.expectedVersion, "expectedVersion", 1, Number.MAX_SAFE_INTEGER);
  const result = await env.DB.prepare(`UPDATE thinking_sessions SET status = 'abandoned', version = version + 1,
    completed_at = ?1, updated_at = ?1 WHERE id = ?2 AND owner_id = ?3 AND version = ?4 AND status = 'active'`)
    .bind(timestamp(), id, OWNER, version).run();
  if (!result.success || result.meta?.changes !== 1) throw new ApiError(409, "version_conflict", "Thinking session cannot be abandoned");
  return new Response(null, { status: 204 });
}

export async function routeClientState(request: Request, env: Env, requestId: string): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === '/v1/preferences' && (request.method === 'GET' || request.method === 'PATCH')) return preferencesRoute(request, env, requestId);
  const article = path.match(/^\/v1\/articles\/([^/]+)\/thinking-sessions$/);
  if (article) return request.method === 'GET' ? listSessions(env, decodeURIComponent(article[1]), requestId)
    : request.method === 'POST' ? createSession(request, env, decodeURIComponent(article[1]), requestId) : undefined;
  const thinking = path.match(/^\/v1\/thinking-sessions\/([^/]+)(?:\/(events|abandon))?$/);
  if (thinking) {
    const id = decodeURIComponent(thinking[1]);
    if (!thinking[2] && request.method === 'GET') return getSession(env, id, requestId);
    if (thinking[2] === 'events' && request.method === 'POST') return appendEvents(request, env, id, requestId);
    if (thinking[2] === 'abandon' && request.method === 'POST') return abandon(request, env, id, requestId);
  }
  return undefined;
}
