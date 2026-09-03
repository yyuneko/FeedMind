import type { AccessIdentity } from "../../shared/src/auth";
import type { AccessApiEnv } from "../../shared/src/api";
import type { D1Database, Fetcher, Queue, R2Bucket, WorkflowBinding } from "../../shared/src/cloudflare";
import { ApiError, json } from "../../shared/src/http";
import { OPENROUTER_ENDPOINT, validateProfile } from "../../ai-service/src/config";
import type { AiProfileConfig } from "../../ai-service/src/types";
import { annotateAndHideContentBlocks, contentHtmlToText } from "../../shared/src/content-blocks";
import { fetchContent } from "../../shared/src/content-fetch";
import {
  extractArticleWithRule,
  extractionPreviewSummary,
  extractionRuleHash,
  validateFeedExtractionRule,
  type FeedExtractionRuleConfig,
} from "../../../src/utils/extractionRules";

export interface AdminApiEnv extends AccessApiEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
  AI_SERVICE: Fetcher;
  FEED_QUEUE: Queue<{ feedId: string; requestId: string; reason: string } | {
    connectionId: string; sourceId?: string; requestId: string; reason: string;
  }>;
  ARTICLE_QUEUE: Queue<{ articleId: string; requestId: string; reason: string }>;
  BODY_TRANSLATION_WORKFLOW: WorkflowBinding<{ translationId: string; attemptId: string; requestId: string }>;
  CLASSIFICATION_WORKFLOW: WorkflowBinding<{ articleId: string; sourceHash: string; sourceTextHash?: string; requestId: string; taskId?: string }>;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 200_000) throw new ApiError(413, "request_too_large", "Request body is too large");
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be a JSON object");
  }
}

function string(value: unknown, name: string, maximum = 1000, required = true): string {
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim())) {
    throw new ApiError(422, "validation_failed", `${name} is invalid`);
  }
  return value.trim();
}

function timestamp(): string { return new Date().toISOString(); }

const OWNER_ID = "owner";

function normalizeFeedUrl(value: unknown): string {
  const raw = string(value, "url", 2048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new ApiError(422, "validation_failed", "url must be a valid HTTP(S) URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ApiError(422, "validation_failed", "url must be a valid HTTP(S) URL without credentials");
  }
  parsed.hash = "";
  return parsed.toString();
}

function pageLimit(url: URL): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 100);
  const offset = Math.min(Math.max(Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0), 100_000);
  return { limit, offset };
}

async function listFeeds(request: Request, env: AdminApiEnv, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const { limit, offset } = pageLimit(url);
  const query = (url.searchParams.get("query") ?? "").trim().slice(0, 200);
  const status = (url.searchParams.get("status") ?? "").trim();
  const sort = (url.searchParams.get("sort") ?? "smart").trim();
  if (status && !["pending", "running", "succeeded", "failed"].includes(status)) {
    throw new ApiError(422, "validation_failed", "status is invalid");
  }
  if (!["smart", "recent"].includes(sort)) {
    throw new ApiError(422, "validation_failed", "sort is invalid");
  }
  const orderBy = sort === "recent"
    ? `COALESCE(b.lastFetchedAt, b.updatedAt, b.createdAt) DESC,
      b.title COLLATE NOCASE ASC, b.id ASC`
    : `CASE b.fetchStatus WHEN 'failed' THEN 0 WHEN 'running' THEN 1
        WHEN 'pending' THEN 2 WHEN 'succeeded' THEN 3 ELSE 4 END ASC,
      CASE WHEN b.fetchStatus = 'failed' THEN b.failureCount END DESC,
      CASE WHEN b.fetchStatus = 'failed'
        THEN COALESCE(b.lastFetchedAt, b.updatedAt, b.createdAt) END DESC,
      CASE WHEN b.fetchStatus IN ('running', 'pending') THEN b.updatedAt END ASC,
      CASE WHEN b.fetchStatus = 'succeeded'
        THEN COALESCE(b.lastFetchedAt, b.updatedAt, b.createdAt) END DESC,
      b.title COLLATE NOCASE ASC, b.id ASC`;
  const result = await env.DB.prepare(`WITH feed_rows AS (
    SELECT f.id, s.id AS subscriptionId, 'direct_rss' AS connectorType,
      'connection:direct-rss:' || f.owner_id AS connectionId,
      COALESCE(NULLIF(s.custom_title, ''), NULLIF(f.title, ''), f.url) AS title,
      f.url, f.site_url AS siteUrl, COALESCE(s.category, '') AS category,
      COALESCE(s.is_active, 0) AS isActive, f.fetch_status AS fetchStatus,
      f.failure_count AS failureCount, f.last_error_code AS lastErrorCode,
      f.last_fetched_at AS lastFetchedAt, f.next_fetch_at AS nextFetchAt,
      f.created_at AS createdAt, f.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM subscriptions sx WHERE sx.feed_id = f.id AND sx.is_active = 1) AS subscriberCount
    FROM feeds f LEFT JOIN subscriptions s ON s.feed_id = f.id AND s.owner_id = ?1
    WHERE f.owner_id = ?1
    UNION ALL
    SELECT src.id, NULL, c.connector_type, c.id, src.title, COALESCE(src.url, ''), src.site_url,
      COALESCE((SELECT group_concat(name, ', ') FROM source_categories sc WHERE sc.source_id = src.id), ''),
      src.enabled,
      CASE src.sync_status WHEN 'syncing' THEN 'running' WHEN 'ok' THEN 'succeeded'
        WHEN 'error' THEN 'failed' ELSE 'pending' END,
      0, COALESCE(src.last_error_code, c.last_error_code),
      COALESCE(src.last_synced_at, c.last_synced_at), c.next_sync_at,
      src.created_at, src.updated_at, 1
    FROM sources src JOIN source_connections c ON c.id = src.connection_id
    WHERE src.owner_id = ?1 AND c.connector_type <> 'direct_rss'
  ), article_scope AS (
    SELECT a.id AS articleId, a.feed_id AS sourceId FROM articles a
      WHERE a.owner_id = ?1 AND a.feed_id IS NOT NULL
    UNION ALL
    SELECT si.article_id, si.source_id FROM source_items si
      JOIN source_connections c ON c.id = si.connection_id
      WHERE si.owner_id = ?1 AND c.connector_type <> 'direct_rss'
  ), article_stats AS (
    SELECT scope.sourceId, COUNT(*) AS articleCount,
      SUM(CASE WHEN a.parse_status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
      SUM(CASE WHEN a.parse_status = 'running' THEN 1 ELSE 0 END) AS runningCount,
      SUM(CASE WHEN a.parse_status = 'completed'
        AND c.id IS NOT NULL AND c.title_status = 'completed'
        AND zh.status = 'completed' AND trim(zh.translated_title) <> ''
        AND en.status = 'completed' AND trim(en.translated_title) <> ''
        AND ja.status = 'completed' AND trim(ja.translated_title) <> '' THEN 1 ELSE 0 END) AS completedCount,
      SUM(CASE WHEN a.parse_status = 'failed' OR (a.parse_status = 'completed' AND (
        c.id IS NULL OR c.title_status <> 'completed'
        OR COALESCE(zh.status, 'missing') <> 'completed' OR COALESCE(trim(zh.translated_title), '') = ''
        OR COALESCE(en.status, 'missing') <> 'completed' OR COALESCE(trim(en.translated_title), '') = ''
        OR COALESCE(ja.status, 'missing') <> 'completed' OR COALESCE(trim(ja.translated_title), '') = ''))
        THEN 1 ELSE 0 END) AS failedCount
      FROM article_scope scope JOIN articles a ON a.id = scope.articleId
      LEFT JOIN article_classifications c ON c.id = (SELECT c2.id FROM article_classifications c2
        WHERE c2.article_id = a.id AND c2.source_hash = a.source_hash AND c2.is_current = 1 ORDER BY c2.created_at DESC LIMIT 1)
      LEFT JOIN article_title_translations zh ON zh.classification_id = c.id AND zh.target_locale = 'zh-CN'
      LEFT JOIN article_title_translations en ON en.classification_id = c.id AND en.target_locale = 'en-US'
      LEFT JOIN article_title_translations ja ON ja.classification_id = c.id AND ja.target_locale = 'ja-JP'
      GROUP BY scope.sourceId
  )
  SELECT b.*, COUNT(*) OVER() AS totalCount,
    COALESCE(stats.articleCount, 0) AS articleCount,
    COALESCE(stats.pendingCount, 0) AS pendingCount,
    COALESCE(stats.runningCount, 0) AS runningCount,
    COALESCE(stats.completedCount, 0) AS completedCount,
    COALESCE(stats.failedCount, 0) AS failedCount
    FROM feed_rows b LEFT JOIN article_stats stats ON stats.sourceId = b.id
    WHERE (?2 = '' OR instr(lower(b.title), lower(?3)) > 0
      OR instr(lower(b.url), lower(?3)) > 0 OR instr(lower(b.category), lower(?3)) > 0)
      AND (?4 = '' OR b.fetchStatus = ?4)
    ORDER BY ${orderBy} LIMIT ?5 OFFSET ?6`)
    .bind(OWNER_ID, query, query, status, limit + 1, offset).all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const items = rows.slice(0, limit).map(({ totalCount: _totalCount, ...item }) => ({
    ...item,
    isActive: Boolean(item.isActive),
  }));
  const total = Number(rows[0]?.totalCount ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return json({ items, limit, offset, total, totalPages, hasMore: rows.length > limit, requestId }, requestId);
}

async function ownedFeed(env: AdminApiEnv, feedId: string): Promise<{ id: string; title: string; url: string }> {
  const feed = await env.DB.prepare(`SELECT id, COALESCE(NULLIF(title, ''), url) AS title, url
    FROM feeds WHERE id = ?1 AND owner_id = ?2`).bind(feedId, OWNER_ID)
    .first<{ id: string; title: string; url: string }>();
  if (!feed) throw new ApiError(404, "not_found", "Feed not found");
  return feed;
}

interface ExtractionRuleVersionRow {
  id: string;
  version: number;
  status: string;
  ruleJson: string;
  configHash: string;
  changeNote: string | null;
  createdByEmail: string;
  createdAt: string;
}

const extractionVersion = (row: ExtractionRuleVersionRow | null | undefined) => row ? ({
  id: row.id,
  version: Number(row.version),
  status: row.status,
  rule: JSON.parse(row.ruleJson) as FeedExtractionRuleConfig,
  configHash: row.configHash,
  changeNote: row.changeNote,
  createdByEmail: row.createdByEmail,
  createdAt: row.createdAt,
}) : null;

async function getFeedExtractionRule(env: AdminApiEnv, feedId: string, requestId: string): Promise<Response> {
  const feed = await ownedFeed(env, feedId);
  const definition = await env.DB.prepare(`SELECT id, draft_version_id AS draftVersionId,
    active_version_id AS activeVersionId FROM feed_extraction_rules WHERE feed_id = ?1`).bind(feedId)
    .first<{ id: string; draftVersionId: string | null; activeVersionId: string | null }>();
  const versions = definition ? await env.DB.prepare(`SELECT id, version, status, rule_json AS ruleJson,
    config_hash AS configHash, change_note AS changeNote, created_by_email AS createdByEmail, created_at AS createdAt
    FROM feed_extraction_rule_versions WHERE rule_id = ?1 ORDER BY version DESC LIMIT 50`).bind(definition.id)
    .all<ExtractionRuleVersionRow>() : { results: [] as ExtractionRuleVersionRow[] };
  const items = (versions.results ?? []).map(extractionVersion);
  const draft = items.find((item) => item?.id === definition?.draftVersionId) ?? null;
  const active = items.find((item) => item?.id === definition?.activeVersionId) ?? null;
  const samples = await env.DB.prepare(`SELECT id, title, canonical_url AS url, source_hash AS sourceHash,
    parsed_at AS parsedAt FROM articles WHERE feed_id = ?1 AND parse_status = 'completed'
    ORDER BY COALESCE(published_at, created_at) DESC LIMIT 30`).bind(feedId).all<Record<string, unknown>>();
  const validations = draft ? await env.DB.prepare(`SELECT article_id AS articleId, preview_hash AS previewHash,
    confirmed_by_email AS confirmedByEmail, confirmed_at AS confirmedAt
    FROM feed_extraction_rule_validations WHERE rule_version_id = ?1 AND config_hash = ?2
    ORDER BY confirmed_at DESC`).bind(draft.id, draft.configHash).all<Record<string, unknown>>() : { results: [] };
  const availableCount = Number((await env.DB.prepare(`SELECT COUNT(*) AS count FROM articles
    WHERE feed_id = ?1 AND parse_status = 'completed'`).bind(feedId).first<{ count: number }>())?.count ?? 0);
  return json({ data: { feed, ruleId: definition?.id ?? null, draft, active, versions: items,
    samples: samples.results ?? [], validations: validations.results ?? [], availableCount,
    requiredValidationCount: 0 }, requestId }, requestId);
}

async function listFeedExtractionSamples(request: Request, env: AdminApiEnv, feedId: string, requestId: string): Promise<Response> {
  await ownedFeed(env, feedId);
  const query = (new URL(request.url).searchParams.get("query") ?? "").trim().slice(0, 200);
  const samples = await env.DB.prepare(`SELECT id, title, canonical_url AS url, source_hash AS sourceHash,
    parsed_at AS parsedAt FROM articles WHERE feed_id = ?1 AND parse_status = 'completed'
    AND (?2 = '' OR instr(lower(title), lower(?3)) > 0 OR instr(lower(canonical_url), lower(?3)) > 0)
    ORDER BY COALESCE(published_at, created_at) DESC LIMIT 50`).bind(feedId, query, query).all<Record<string, unknown>>();
  return json({ items: samples.results ?? [], requestId }, requestId);
}

async function saveFeedExtractionDraft(request: Request, env: AdminApiEnv, feedId: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  await ownedFeed(env, feedId);
  const input = await body(request);
  let rule: FeedExtractionRuleConfig;
  try { rule = validateFeedExtractionRule(input.rule); }
  catch (error) { throw new ApiError(422, "validation_failed", error instanceof Error ? error.message : "Rule is invalid"); }
  const changeNote = input.changeNote == null ? null : string(input.changeNote, "changeNote", 300, false) || null;
  const configHash = await extractionRuleHash(rule);
  let definition = await env.DB.prepare(`SELECT id, draft_version_id AS draftVersionId
    FROM feed_extraction_rules WHERE feed_id = ?1`).bind(feedId).first<{ id: string; draftVersionId: string | null }>();
  const now = timestamp();
  const ruleId = definition?.id ?? crypto.randomUUID();
  const maximum = definition ? await env.DB.prepare(`SELECT COALESCE(MAX(version), 0) AS version
    FROM feed_extraction_rule_versions WHERE rule_id = ?1`).bind(ruleId).first<{ version: number }>() : null;
  const version = Number(maximum?.version ?? 0) + 1;
  const versionId = crypto.randomUUID();
  const statements = [];
  if (!definition) statements.push(env.DB.prepare(`INSERT INTO feed_extraction_rules
    (id, feed_id, created_by_subject, created_by_email, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?5)`).bind(ruleId, feedId, identity.subject, identity.email, now));
  if (definition?.draftVersionId) statements.push(env.DB.prepare(`UPDATE feed_extraction_rule_versions
    SET status = 'archived' WHERE id = ?1 AND status = 'draft'`).bind(definition.draftVersionId));
  statements.push(env.DB.prepare(`INSERT INTO feed_extraction_rule_versions
    (id, rule_id, version, status, rule_json, config_hash, change_note,
     created_by_subject, created_by_email, created_at)
    VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, ?9)`)
    .bind(versionId, ruleId, version, JSON.stringify(rule), configHash, changeNote, identity.subject, identity.email, now));
  statements.push(env.DB.prepare(`UPDATE feed_extraction_rules SET draft_version_id = ?1, updated_at = ?2 WHERE id = ?3`)
    .bind(versionId, now, ruleId));
  await env.DB.batch(statements);
  definition = { id: ruleId, draftVersionId: versionId };
  return json({ data: { ruleId, draft: { id: versionId, version, status: "draft", rule, configHash,
    changeNote, createdByEmail: identity.email, createdAt: now } }, requestId }, requestId, 201);
}

async function currentExtractionDraft(env: AdminApiEnv, feedId: string): Promise<ExtractionRuleVersionRow & { ruleId: string }> {
  const draft = await env.DB.prepare(`SELECT v.id, v.rule_id AS ruleId, v.version, v.status,
    v.rule_json AS ruleJson, v.config_hash AS configHash, v.change_note AS changeNote,
    v.created_by_email AS createdByEmail, v.created_at AS createdAt
    FROM feed_extraction_rules r JOIN feed_extraction_rule_versions v ON v.id = r.draft_version_id
    WHERE r.feed_id = ?1 AND v.status = 'draft'`).bind(feedId)
    .first<ExtractionRuleVersionRow & { ruleId: string }>();
  if (!draft) throw new ApiError(409, "draft_not_found", "Save a draft rule before previewing or publishing");
  return draft;
}

async function digestText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function draftExtractionPreview(env: AdminApiEnv, feedId: string, articleId: string,
  draft: ExtractionRuleVersionRow & { ruleId: string }) {
  const article = await env.DB.prepare(`SELECT id, canonical_url AS url FROM articles
    WHERE id = ?1 AND feed_id = ?2 AND parse_status = 'completed'`).bind(articleId, feedId).first<{ id: string; url: string }>();
  if (!article) throw new ApiError(404, "not_found", "Preview article not found");
  const fetched = await fetchContent(article.url, "html");
  const draftRule = validateFeedExtractionRule(JSON.parse(draft.ruleJson));
  const candidateResult = extractArticleWithRule(fetched.body, fetched.finalUrl, draftRule);
  const candidate = extractionPreviewSummary(candidateResult);
  const previewHash = await digestText(`${draft.configHash}\n${articleId}\n${fetched.finalUrl}\n${candidateResult.html}`);
  return { article, fetched, draftRule, candidate, previewHash };
}

async function previewFeedExtractionRule(request: Request, env: AdminApiEnv, feedId: string, requestId: string): Promise<Response> {
  await ownedFeed(env, feedId);
  const input = await body(request);
  const articleId = string(input.articleId, "articleId", 100);
  const draft = await currentExtractionDraft(env, feedId);
  const active = await env.DB.prepare(`SELECT v.rule_json AS ruleJson FROM feed_extraction_rules r
    JOIN feed_extraction_rule_versions v ON v.id = r.active_version_id
    WHERE r.feed_id = ?1 AND v.status = 'active'`).bind(feedId).first<{ ruleJson: string }>();
  const preview = await draftExtractionPreview(env, feedId, articleId, draft);
  const activeRule = active ? validateFeedExtractionRule(JSON.parse(active.ruleJson)) : null;
  const current = extractionPreviewSummary(extractArticleWithRule(preview.fetched.body, preview.fetched.finalUrl, activeRule));
  return json({ data: { articleId, finalUrl: preview.fetched.finalUrl, draftVersionId: draft.id,
    configHash: draft.configHash, previewHash: preview.previewHash, current, candidate: preview.candidate }, requestId }, requestId);
}

async function confirmFeedExtractionPreview(request: Request, env: AdminApiEnv, feedId: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  await ownedFeed(env, feedId);
  const input = await body(request);
  const articleId = string(input.articleId, "articleId", 100);
  const previewHash = string(input.previewHash, "previewHash", 64);
  const draft = await currentExtractionDraft(env, feedId);
  const preview = await draftExtractionPreview(env, feedId, articleId, draft);
  if (preview.previewHash !== previewHash) throw new ApiError(409, "preview_changed", "The live preview changed; review the article again before confirming");
  const now = timestamp();
  await env.DB.prepare(`INSERT INTO feed_extraction_rule_validations
    (id, rule_version_id, article_id, config_hash, preview_hash, confirmed_by_subject, confirmed_by_email, confirmed_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(rule_version_id, article_id) DO UPDATE SET preview_hash = excluded.preview_hash,
      config_hash = excluded.config_hash, confirmed_by_subject = excluded.confirmed_by_subject,
      confirmed_by_email = excluded.confirmed_by_email, confirmed_at = excluded.confirmed_at`)
    .bind(crypto.randomUUID(), draft.id, articleId, draft.configHash, previewHash, identity.subject, identity.email, now).run();
  return json({ data: { articleId, draftVersionId: draft.id, confirmedAt: now }, requestId }, requestId);
}

async function publishFeedExtractionDraft(request: Request, env: AdminApiEnv, feedId: string, requestId: string): Promise<Response> {
  await ownedFeed(env, feedId);
  const input = await body(request);
  const sampleInput = input.sampleArticleIds ?? [];
  if (!Array.isArray(sampleInput) || sampleInput.length > 50 || sampleInput.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ApiError(422, "validation_failed", "sampleArticleIds is invalid");
  }
  const selectedArticleIds = Array.from(new Set(sampleInput.map(String)));
  const draft = await currentExtractionDraft(env, feedId);
  const validSelectedRows = selectedArticleIds.length ? await env.DB.prepare(`SELECT id FROM articles
    WHERE feed_id = ?1 AND parse_status = 'completed' AND id IN (${selectedArticleIds.map((_, index) => `?${index + 2}`).join(", ")})`)
    .bind(feedId, ...selectedArticleIds).all<{ id: string }>() : { results: [] as Array<{ id: string }> };
  const validSelectedArticleIds = (validSelectedRows.results ?? []).map((item) => item.id);
  const definition = await env.DB.prepare(`SELECT active_version_id AS activeVersionId FROM feed_extraction_rules
    WHERE id = ?1 AND feed_id = ?2`).bind(draft.ruleId, feedId).first<{ activeVersionId: string | null }>();
  const now = timestamp();
  const statements = [];
  if (definition?.activeVersionId) statements.push(env.DB.prepare(`UPDATE feed_extraction_rule_versions SET status = 'archived'
    WHERE id = ?1 AND status = 'active'`).bind(definition.activeVersionId));
  statements.push(env.DB.prepare(`UPDATE feed_extraction_rule_versions SET status = 'active'
    WHERE id = ?1 AND status = 'draft'`).bind(draft.id));
  statements.push(env.DB.prepare(`UPDATE feed_extraction_rules SET active_version_id = ?1,
    draft_version_id = NULL, updated_at = ?2 WHERE id = ?3 AND draft_version_id = ?1`)
    .bind(draft.id, now, draft.ruleId));
  await env.DB.batch(statements);
  return json({ data: { feedId, activeVersionId: draft.id, version: Number(draft.version),
    confirmed: 0, required: 0, selectedArticleIds: validSelectedArticleIds }, requestId }, requestId);
}

async function abandonFeedExtractionDraft(env: AdminApiEnv, feedId: string, requestId: string): Promise<Response> {
  await ownedFeed(env, feedId);
  const draft = await currentExtractionDraft(env, feedId);
  await env.DB.batch([
    env.DB.prepare(`UPDATE feed_extraction_rule_versions SET status = 'archived' WHERE id = ?1 AND status = 'draft'`).bind(draft.id),
    env.DB.prepare(`UPDATE feed_extraction_rules SET draft_version_id = NULL, updated_at = ?1
      WHERE id = ?2 AND draft_version_id = ?3`).bind(timestamp(), draft.ruleId, draft.id),
  ]);
  return json({ data: { feedId, abandonedVersionId: draft.id }, requestId }, requestId);
}

async function rollbackFeedExtractionRule(env: AdminApiEnv, feedId: string, versionId: string, requestId: string): Promise<Response> {
  await ownedFeed(env, feedId);
  const target = await env.DB.prepare(`SELECT v.id, v.rule_id AS ruleId, v.version, r.active_version_id AS activeVersionId
    FROM feed_extraction_rule_versions v JOIN feed_extraction_rules r ON r.id = v.rule_id
    WHERE v.id = ?1 AND r.feed_id = ?2 AND v.status IN ('active', 'archived')`).bind(versionId, feedId)
    .first<{ id: string; ruleId: string; version: number; activeVersionId: string | null }>();
  if (!target) throw new ApiError(404, "not_found", "Rule version not found");
  if (target.activeVersionId === target.id) return json({ data: { feedId, activeVersionId: target.id, version: target.version }, requestId }, requestId);
  await env.DB.batch([
    env.DB.prepare(`UPDATE feed_extraction_rule_versions SET status = 'archived' WHERE id = ?1 AND status = 'active'`).bind(target.activeVersionId),
    env.DB.prepare(`UPDATE feed_extraction_rule_versions SET status = 'active' WHERE id = ?1 AND status = 'archived'`).bind(target.id),
    env.DB.prepare(`UPDATE feed_extraction_rules SET active_version_id = ?1, updated_at = ?2 WHERE id = ?3`).bind(target.id, timestamp(), target.ruleId),
  ]);
  return json({ data: { feedId, activeVersionId: target.id, version: target.version }, requestId }, requestId);
}

async function addFeed(request: Request, env: AdminApiEnv, requestId: string, identity: AccessIdentity): Promise<Response> {
  const input = await body(request);
  const url = normalizeFeedUrl(input.url);
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 500) : "";
  const category = typeof input.category === "string" ? input.category.trim().slice(0, 200) : "";
  const now = timestamp();
  await env.DB.prepare(`INSERT INTO feeds (id, owner_id, url, title, fetch_status, next_fetch_at, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5, ?5)
    ON CONFLICT(owner_id, url) DO UPDATE SET
      title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE feeds.title END,
      fetch_status = 'pending', last_error_code = NULL, next_fetch_at = excluded.next_fetch_at, updated_at = excluded.updated_at`)
    .bind(crypto.randomUUID(), OWNER_ID, url, title, now).run();
  const feed = await env.DB.prepare("SELECT id FROM feeds WHERE owner_id = ?1 AND url = ?2")
    .bind(OWNER_ID, url).first<{ id: string }>();
  if (!feed) throw new ApiError(500, "database_error", "Unable to create feed");
  await env.DB.prepare(`INSERT INTO subscriptions
    (id, owner_id, feed_id, category, custom_title, is_active, created_at, updated_at)
    VALUES (?1, ?2, ?3, NULLIF(?4, ''), NULLIF(?5, ''), 1, ?6, ?6)
    ON CONFLICT(owner_id, feed_id) DO UPDATE SET category = excluded.category,
      custom_title = COALESCE(excluded.custom_title, subscriptions.custom_title), is_active = 1, updated_at = excluded.updated_at`)
    .bind(crypto.randomUUID(), OWNER_ID, feed.id, category, title, now).run();
  await env.FEED_QUEUE.send({ feedId: feed.id, requestId, reason: "admin_created" }, { contentType: "json" });
  return json({ data: { feedId: feed.id, status: "queued" }, requestId }, requestId, 202);
}

async function refreshFeed(env: AdminApiEnv, feedId: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const feed = await env.DB.prepare("SELECT fetch_status AS fetchStatus FROM feeds WHERE id = ?1 AND owner_id = ?2")
    .bind(feedId, OWNER_ID).first<{ fetchStatus: string }>();
  if (!feed) {
    const source = await env.DB.prepare(`SELECT s.id, s.connection_id AS connectionId, c.status
      FROM sources s JOIN source_connections c ON c.id = s.connection_id
      WHERE s.id = ?1 AND s.owner_id = ?2 AND c.connector_type <> 'direct_rss'`)
      .bind(feedId, OWNER_ID).first<{ id: string; connectionId: string; status: string }>();
    if (!source) throw new ApiError(404, "not_found", "Feed not found");
    if (source.status === "syncing") throw new ApiError(409, "feed_fetch_active", "Source connection sync is already running");
    const now = timestamp();
    await env.DB.batch([
      env.DB.prepare("UPDATE source_connections SET status = 'pending', last_error_code = NULL, next_sync_at = ?1, updated_at = ?1 WHERE id = ?2").bind(now, source.connectionId),
      env.DB.prepare("UPDATE sources SET sync_status = 'pending', last_error_code = NULL, updated_at = ?1 WHERE id = ?2").bind(now, source.id),
    ]);
    await env.FEED_QUEUE.send({ connectionId: source.connectionId, sourceId: source.id, requestId, reason: "admin_refresh" }, { contentType: "json" });
    return json({ data: { sourceId: source.id, connectionId: source.connectionId, status: "queued" }, requestId }, requestId, 202);
  }
  if (feed.fetchStatus === "running") throw new ApiError(409, "feed_fetch_active", "Feed fetch is already running");
  const now = timestamp();
  await env.DB.prepare("UPDATE feeds SET fetch_status = 'pending', last_error_code = NULL, next_fetch_at = ?1, updated_at = ?1 WHERE id = ?2")
    .bind(now, feedId).run();
  await env.FEED_QUEUE.send({ feedId, requestId, reason: "admin_refresh" }, { contentType: "json" });
  return json({ data: { feedId, status: "queued" }, requestId }, requestId, 202);
}

async function deleteFeed(env: AdminApiEnv, feedId: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const feed = await env.DB.prepare(`SELECT id, url, title,
    (SELECT COUNT(*) FROM subscriptions s WHERE s.feed_id = feeds.id AND s.is_active = 1) AS subscriberCount
    FROM feeds WHERE id = ?1 AND owner_id = ?2`).bind(feedId, OWNER_ID)
    .first<{ id: string; url: string; title: string; subscriberCount: number }>();
  if (!feed) throw new ApiError(404, "not_found", "Feed not found");
  if (Number(feed.subscriberCount) > 0) {
    throw new ApiError(409, "feed_has_subscribers", "Feed cannot be deleted while users are subscribed");
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM feeds WHERE id = ?1 AND owner_id = ?2
      AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = feeds.id AND s.is_active = 1)`)
      .bind(feedId, OWNER_ID),
  ]);
  return new Response(null, { status: 204 });
}

async function listParseProgress(request: Request, env: AdminApiEnv, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const { limit, offset } = pageLimit(url);
  const feedId = (url.searchParams.get("feedId") ?? "").trim().slice(0, 100);
  const status = (url.searchParams.get("status") ?? "").trim();
  const query = (url.searchParams.get("query") ?? "").trim().slice(0, 200);
  if (status && !["pending", "running", "completed", "failed"].includes(status)) {
    throw new ApiError(422, "validation_failed", "status is invalid");
  }
  const result = await env.DB.prepare(`SELECT a.id, a.feed_id AS feedId, a.title, a.canonical_url AS url,
    COUNT(*) OVER() AS totalCount,
    a.parse_status AS parseStatus, a.parser_version AS parserVersion, a.parse_error AS parseError,
    a.extraction_rule_version_id AS extractionRuleVersionId, a.extraction_strategy AS extractionStrategy,
    a.extraction_diagnostic_code AS extractionDiagnosticCode,
    a.published_at AS publishedAt, a.parsed_at AS parsedAt, a.updated_at AS updatedAt,
    COALESCE(NULLIF(f.title, ''), f.url,
      (SELECT src.title FROM source_items si JOIN sources src ON src.id = si.source_id
        WHERE si.article_id = a.id ORDER BY si.first_seen_at LIMIT 1)) AS feedTitle,
    t.id AS taskId, t.status AS taskStatus, t.attempt_count AS attemptCount,
    t.error_code AS errorCode, t.error_message AS errorMessage, t.requested_by AS requestedBy,
    t.created_at AS taskCreatedAt, t.started_at AS startedAt, t.completed_at AS completedAt,
    CASE
      WHEN a.parse_status <> 'completed' THEN 'blocked'
      WHEN pr.id IS NOT NULL THEN 'completed'
      WHEN pt.error_code = 'content_too_large' THEN 'content_too_large'
      WHEN pt.status IN ('pending', 'running', 'failed') THEN pt.status
      ELSE 'missing'
    END AS preprocessingStatus,
    pt.id AS preprocessingTaskId, pt.attempt_count AS preprocessingAttemptCount,
    pt.error_code AS preprocessingErrorCode, pt.error_message AS preprocessingErrorMessage,
    pd.diagnostic_object_key AS preprocessingDiagnosticKey,
    COALESCE((SELECT json_group_array(json_object(
      'key', ranked_tags.tag_key,
      'name', COALESCE(json_extract(ranked_tags.names_json, '$."zh-CN"'), ranked_tags.tag_key),
      'status', ranked_tags.status
    )) FROM (
      SELECT tg.tag_key, tg.names_json, tg.status
      FROM article_topic_tags apt JOIN topic_tags tg ON tg.id = apt.tag_id
      WHERE apt.run_id = pr.id ORDER BY apt.rank LIMIT 5
    ) ranked_tags), '[]') AS topicTagsJson
    FROM articles a LEFT JOIN feeds f ON f.id = a.feed_id
    LEFT JOIN article_parse_tasks t ON t.id = (SELECT t2.id FROM article_parse_tasks t2
      WHERE t2.article_id = a.id ORDER BY t2.created_at DESC LIMIT 1)
    LEFT JOIN article_preprocessing_runs pr ON pr.id = (SELECT pr2.id FROM article_preprocessing_runs pr2
      WHERE pr2.article_id = a.id AND pr2.source_text_hash = a.source_text_hash
        AND pr2.status = 'completed' AND pr2.is_current = 1
      ORDER BY pr2.created_at DESC LIMIT 1)
    LEFT JOIN article_preprocessing_tasks pt ON pt.id = (SELECT pt2.id FROM article_preprocessing_tasks pt2
      WHERE pt2.article_id = a.id AND pt2.source_text_hash = a.source_text_hash
      ORDER BY pt2.created_at DESC LIMIT 1)
    LEFT JOIN article_preprocessing_diagnostics pd ON pd.id = (SELECT pd2.id FROM article_preprocessing_diagnostics pd2
      WHERE pd2.task_id = pt.id ORDER BY pd2.created_at DESC LIMIT 1)
    WHERE a.owner_id = ?1 AND (?2 = '' OR a.feed_id = ?2 OR EXISTS (
      SELECT 1 FROM source_items sif WHERE sif.article_id = a.id AND sif.source_id = ?2))
      AND (?3 = '' OR a.parse_status = ?3)
      AND (?4 = '' OR instr(lower(COALESCE(a.title, '')), lower(?5)) > 0
        OR instr(lower(a.canonical_url), lower(?5)) > 0)
    ORDER BY CASE a.parse_status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
      a.updated_at DESC LIMIT ?6 OFFSET ?7`)
    .bind(OWNER_ID, feedId, status, query, query, limit + 1, offset).all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const total = Number(rows[0]?.totalCount ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const items = await Promise.all(rows.slice(0, limit).map(async ({ totalCount: _totalCount, topicTagsJson, ...item }) => {
    let preprocessingDiagnostic = null;
    if (item.preprocessingStatus === "failed" || item.preprocessingStatus === "content_too_large") {
      const key = typeof item.preprocessingDiagnosticKey === "string" ? item.preprocessingDiagnosticKey : "";
      const object = key ? await env.CONTENT.get(key) : null;
      if (object) {
        try { preprocessingDiagnostic = JSON.parse(await object.text()); }
        catch { preprocessingDiagnostic = { input: null, output: null, unavailable: true }; }
      }
    }
    const { preprocessingDiagnosticKey: _preprocessingDiagnosticKey, ...publicItem } = item;
    return { ...publicItem, topicTags: JSON.parse(String(topicTagsJson ?? "[]")), preprocessingDiagnostic };
  }));
  return json({ items, limit, offset, total, totalPages, hasMore: rows.length > limit, requestId }, requestId);
}

async function listPrompts(env: AdminApiEnv, requestId: string): Promise<Response> {
  const result = await env.DB.prepare(`SELECT d.id, d.task, d.article_type AS articleType,
    d.target_locale AS targetLocale, d.current_version_id AS currentVersionId, d.deleted_at AS deletedAt,
    v.version AS currentVersion, v.status, v.content_hash AS contentHash,
    d.created_at AS createdAt, d.updated_at AS updatedAt
    FROM prompt_definitions d LEFT JOIN prompt_versions v ON v.id = d.current_version_id
    WHERE d.deleted_at IS NULL
    ORDER BY d.task, d.article_type, d.target_locale`).all<Record<string, unknown>>();
  return json({ items: result.results ?? [], requestId }, requestId);
}

function validatePromptKey(input: Record<string, unknown>) {
  const task = string(input.task, "task", 50) as "classification" | "title_translation" | "body_translation" | "body_repair";
  if (!["classification", "title_translation", "body_translation", "body_repair"].includes(task)) {
    throw new ApiError(422, "validation_failed", "Prompt task is invalid");
  }
  const articleType = input.articleType == null ? null : string(input.articleType, "articleType", 30);
  if ((task === "classification" || task === "title_translation") && articleType !== null) {
    throw new ApiError(422, "validation_failed", "Classification and title prompts must be global");
  }
  if ((task === "body_translation" || task === "body_repair") && !["technical", "news", "general"].includes(articleType ?? "")) {
    throw new ApiError(422, "validation_failed", "Body prompts require a valid article type");
  }
  return { task, articleType, targetLocale: string(input.targetLocale, "targetLocale", 35) };
}

async function createPrompt(request: Request, env: AdminApiEnv, requestId: string, identity: AccessIdentity): Promise<Response> {
  const input = await body(request);
  const key = validatePromptKey(input);
  const content = string(input.content, "content", 100_000);
  const existing = await env.DB.prepare(`SELECT id FROM prompt_definitions
    WHERE task = ?1 AND ifnull(article_type, '') = ifnull(?2, '') AND target_locale = ?3 AND deleted_at IS NULL`)
    .bind(key.task, key.articleType, key.targetLocale).first<{ id: string }>();
  if (existing) throw new ApiError(409, "prompt_key_exists", "An active prompt definition already exists for this key");
  const definitionId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = timestamp();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const contentHash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO prompt_definitions
      (id, task, article_type, target_locale, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)`).bind(definitionId, key.task, key.articleType, key.targetLocale, now),
    env.DB.prepare(`INSERT INTO prompt_versions
      (id, definition_id, version, status, content, content_hash, change_note, created_by_subject, created_by_email, created_at)
      VALUES (?1, ?2, 1, 'draft', ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(versionId, definitionId, content, contentHash, input.changeNote ?? null, identity.subject, identity.email, now),
    env.DB.prepare(`INSERT INTO prompt_change_logs
      (id, definition_id, action, after_version_id, actor_subject, actor_email, change_note, request_id, created_at)
      VALUES (?1, ?2, 'create', ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(crypto.randomUUID(), definitionId, versionId, identity.subject, identity.email, input.changeNote ?? null, requestId, now),
  ]);
  return json({ data: { definitionId, versionId, version: 1, status: "draft" }, requestId }, requestId, 201);
}

async function listPromptVersions(env: AdminApiEnv, definitionId: string, requestId: string): Promise<Response> {
  const result = await env.DB.prepare(`SELECT id, definition_id AS definitionId, version, status, content,
    content_hash AS contentHash, change_note AS changeNote, created_by_email AS createdByEmail, created_at AS createdAt
    FROM prompt_versions WHERE definition_id = ?1 ORDER BY version DESC`).bind(definitionId).all();
  return json({ items: result.results ?? [], requestId }, requestId);
}

async function editPrompt(request: Request, env: AdminApiEnv, definitionId: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const input = await body(request);
  const content = string(input.content, "content", 100_000);
  const definition = await env.DB.prepare("SELECT id, current_version_id AS currentVersionId FROM prompt_definitions WHERE id = ?1 AND deleted_at IS NULL")
    .bind(definitionId).first<{ id: string; currentVersionId: string | null }>();
  if (!definition) throw new ApiError(404, "not_found", "Prompt definition not found");
  const maximum = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM prompt_versions WHERE definition_id = ?1")
    .bind(definitionId).first<{ version: number }>();
  const version = Number(maximum?.version ?? 0) + 1;
  const versionId = crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const now = timestamp();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO prompt_versions
      (id, definition_id, version, status, content, content_hash, change_note, created_by_subject, created_by_email, created_at)
      VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(versionId, definitionId, version, content, hash, input.changeNote ?? null, identity.subject, identity.email, now),
    env.DB.prepare(`INSERT INTO prompt_change_logs
      (id, definition_id, action, before_version_id, after_version_id, actor_subject, actor_email, change_note, request_id, created_at)
      VALUES (?1, ?2, 'edit', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(crypto.randomUUID(), definitionId, definition.currentVersionId, versionId, identity.subject, identity.email, input.changeNote ?? null, requestId, now),
  ]);
  return json({ data: { definitionId, versionId, version, status: "draft" }, requestId }, requestId, 201);
}

async function publishPrompt(request: Request, env: AdminApiEnv, definitionId: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const input = await body(request);
  const versionId = string(input.versionId, "versionId", 100);
  const definition = await env.DB.prepare("SELECT current_version_id AS currentVersionId FROM prompt_definitions WHERE id = ?1 AND deleted_at IS NULL")
    .bind(definitionId).first<{ currentVersionId: string | null }>();
  const version = await env.DB.prepare("SELECT id FROM prompt_versions WHERE id = ?1 AND definition_id = ?2 AND status <> 'deleted'")
    .bind(versionId, definitionId).first<{ id: string }>();
  if (!definition || !version) throw new ApiError(404, "not_found", "Prompt definition or version not found");
  const now = timestamp();
  await env.DB.batch([
    env.DB.prepare("UPDATE prompt_versions SET status = 'archived' WHERE definition_id = ?1 AND status = 'active'").bind(definitionId),
    env.DB.prepare("UPDATE prompt_versions SET status = 'active' WHERE id = ?1").bind(versionId),
    env.DB.prepare("UPDATE prompt_definitions SET current_version_id = ?1, updated_at = ?2 WHERE id = ?3").bind(versionId, now, definitionId),
    env.DB.prepare(`INSERT INTO prompt_change_logs
      (id, definition_id, action, before_version_id, after_version_id, actor_subject, actor_email, change_note, request_id, created_at)
      VALUES (?1, ?2, 'publish', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(crypto.randomUUID(), definitionId, definition.currentVersionId, versionId, identity.subject, identity.email, input.changeNote ?? null, requestId, now),
  ]);
  return json({ data: { definitionId, versionId, status: "active" }, requestId }, requestId);
}

async function rollbackPrompt(request: Request, env: AdminApiEnv, definitionId: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const input = await body(request);
  const targetVersionId = string(input.versionId, "versionId", 100);
  const target = await env.DB.prepare(`SELECT content, content_hash AS contentHash FROM prompt_versions
    WHERE id = ?1 AND definition_id = ?2 AND status <> 'deleted'`).bind(targetVersionId, definitionId)
    .first<{ content: string; contentHash: string }>();
  const definition = await env.DB.prepare("SELECT current_version_id AS currentVersionId FROM prompt_definitions WHERE id = ?1 AND deleted_at IS NULL")
    .bind(definitionId).first<{ currentVersionId: string | null }>();
  if (!target || !definition) throw new ApiError(404, "not_found", "Prompt definition or rollback version not found");
  const maximum = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM prompt_versions WHERE definition_id = ?1")
    .bind(definitionId).first<{ version: number }>();
  const version = Number(maximum?.version ?? 0) + 1;
  const versionId = crypto.randomUUID();
  const now = timestamp();
  await env.DB.batch([
    env.DB.prepare("UPDATE prompt_versions SET status = 'archived' WHERE definition_id = ?1 AND status = 'active'").bind(definitionId),
    env.DB.prepare(`INSERT INTO prompt_versions
      (id, definition_id, version, status, content, content_hash, change_note, created_by_subject, created_by_email, created_at)
      VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(versionId, definitionId, version, target.content, target.contentHash,
        input.changeNote ?? `Rollback from ${targetVersionId}`, identity.subject, identity.email, now),
    env.DB.prepare("UPDATE prompt_definitions SET current_version_id = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(versionId, now, definitionId),
    env.DB.prepare(`INSERT INTO prompt_change_logs
      (id, definition_id, action, before_version_id, after_version_id, actor_subject, actor_email, change_note, request_id, created_at)
      VALUES (?1, ?2, 'rollback', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(crypto.randomUUID(), definitionId, definition.currentVersionId, versionId, identity.subject, identity.email,
        input.changeNote ?? null, requestId, now),
  ]);
  return json({ data: { definitionId, versionId, version, status: "active" }, requestId }, requestId, 201);
}

async function testPrompt(request: Request, env: AdminApiEnv, definitionId: string, requestId: string): Promise<Response> {
  const input = await body(request);
  const versionId = input.versionId == null ? null : string(input.versionId, "versionId", 100);
  const version = await env.DB.prepare(`SELECT d.task, v.id, v.content FROM prompt_versions v
    JOIN prompt_definitions d ON d.id = v.definition_id
    WHERE v.id = COALESCE(?1, d.current_version_id) AND d.id = ?2 AND v.status <> 'deleted'`).bind(versionId, definitionId)
    .first<{ id: string; task: string; content: string }>();
  if (!version) throw new ApiError(404, "not_found", "Prompt version not found");
  let sample = input.input == null ? "" : string(input.input, "input", 200_000);
  if (!sample && input.articleId != null) {
    const articleId = string(input.articleId, "articleId", 100);
    const article = await env.DB.prepare(`SELECT title, summary, source_html_key AS sourceHtmlKey FROM articles WHERE id = ?1`)
      .bind(articleId).first<{ title: string; summary: string | null; sourceHtmlKey: string | null }>();
    if (!article?.sourceHtmlKey) throw new ApiError(404, "article_content_unavailable", "Article content is unavailable");
    const object = await env.CONTENT.get(article.sourceHtmlKey);
    if (!object) throw new ApiError(404, "article_content_unavailable", "Article content object is missing");
    const filtered = annotateAndHideContentBlocks(await object.text());
    sample = JSON.stringify({ title: article.title, summary: article.summary, body: contentHtmlToText(filtered).slice(0, 100_000) });
  }
  if (!sample) throw new ApiError(422, "validation_failed", "input or articleId is required");
  const profile = version.task === "body_translation" || version.task === "body_repair" ? "quality" : "fast";
  const profileVersion = await env.DB.prepare("SELECT id, provider, model FROM ai_profile_versions WHERE profile = ?1 AND provider = 'openrouter' AND status = 'active'")
    .bind(profile).first<{ id: string; provider: string; model: string }>();
  if (!profileVersion) throw new ApiError(503, "ai_profile_unavailable", `Active ${profile} AI profile is not configured`);
  const response = await env.AI_SERVICE.fetch("https://feedmind-ai-service.internal/invoke", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, system: version.content, messages: [{ role: "user", content: sample }], json: false }),
  });
  if (!response.ok) throw new ApiError(422, "prompt_test_failed", "Prompt test invocation failed");
  const result = await response.json() as { data?: { usage?: Record<string, unknown>; latencyMs?: unknown }; [key: string]: unknown };
  const usage = result.data?.usage ?? {};
  await env.DB.prepare(`INSERT INTO ai_usage_events
    (id, purpose, profile_version_id, provider, model, status, input_tokens, output_tokens, thinking_tokens,
     latency_ms, request_id, created_at) VALUES (?1, 'prompt_test', ?2, ?3, ?4, 'completed', ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(crypto.randomUUID(), profileVersion.id, profileVersion.provider, profileVersion.model,
      Number(usage.inputTokens ?? 0), Number(usage.outputTokens ?? 0), Number(usage.thinkingTokens ?? 0),
      Number(result.data?.latencyMs ?? 0), requestId, timestamp()).run();
  return json({ ...result, requestId }, requestId);
}

async function deletePrompt(request: Request, env: AdminApiEnv, definitionId: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const input = await body(request);
  const definition = await env.DB.prepare(`SELECT task, article_type AS articleType, target_locale AS targetLocale,
    current_version_id AS currentVersionId FROM prompt_definitions WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(definitionId).first<{ task: string; articleType: string | null; targetLocale: string; currentVersionId: string | null }>();
  if (!definition) throw new ApiError(404, "not_found", "Prompt definition not found");
  const now = timestamp();
  const statements = [
    env.DB.prepare("UPDATE prompt_definitions SET deleted_at = ?1, current_version_id = NULL, updated_at = ?1 WHERE id = ?2")
      .bind(now, definitionId),
    env.DB.prepare("UPDATE prompt_versions SET status = CASE WHEN status = 'active' THEN 'archived' ELSE status END WHERE definition_id = ?1")
      .bind(definitionId),
  ];
  statements.push(
    env.DB.prepare(`INSERT INTO prompt_change_logs
      (id, definition_id, action, before_version_id, actor_subject, actor_email, change_note, request_id, created_at)
      VALUES (?1, ?2, 'delete', ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(crypto.randomUUID(), definitionId, definition.currentVersionId, identity.subject, identity.email,
        input.changeNote ?? null, requestId, now),
  );
  await env.DB.batch(statements);
  return json({ data: { definitionId, deleted: true }, requestId }, requestId);
}

async function promptLogs(env: AdminApiEnv, requestId: string, definitionId?: string): Promise<Response> {
  const statement = env.DB.prepare(`SELECT id, definition_id AS definitionId, action,
    before_version_id AS beforeVersionId, after_version_id AS afterVersionId,
    actor_email AS actorEmail, change_note AS changeNote, request_id AS requestId, created_at AS createdAt
    FROM prompt_change_logs ${definitionId ? "WHERE definition_id = ?1" : ""} ORDER BY created_at DESC LIMIT 500`);
  const result = await (definitionId ? statement.bind(definitionId) : statement).all();
  return json({ items: result.results ?? [], requestId }, requestId);
}

async function listArticleTypes(env: AdminApiEnv, requestId: string): Promise<Response> {
  const result = await env.DB.prepare(`SELECT key, display_name AS displayName, description,
    is_enabled AS isEnabled, updated_at AS updatedAt FROM article_types ORDER BY key`).all<Record<string, unknown>>();
  return json({ items: (result.results ?? []).map((row) => ({ ...row, isEnabled: row.isEnabled === 1 })), requestId }, requestId);
}

async function updateArticleType(request: Request, env: AdminApiEnv, key: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  if (!["technical", "news", "general"].includes(key)) throw new ApiError(404, "not_found", "Article type not found");
  const input = await body(request);
  const current = await env.DB.prepare(`SELECT display_name AS displayName, description, is_enabled AS isEnabled
    FROM article_types WHERE key = ?1`).bind(key).first<Record<string, unknown>>();
  if (!current) throw new ApiError(404, "not_found", "Article type not found");
  const next = {
    displayName: input.displayName == null ? String(current.displayName) : string(input.displayName, "displayName", 80),
    description: input.description == null ? String(current.description) : string(input.description, "description", 1000),
    isEnabled: input.isEnabled == null ? current.isEnabled === 1 : input.isEnabled === true,
  };
  await env.DB.prepare(`UPDATE article_types SET display_name = ?1, description = ?2, is_enabled = ?3, updated_at = ?4 WHERE key = ?5`)
    .bind(next.displayName, next.description, next.isEnabled ? 1 : 0, timestamp(), key).run();
  return json({ data: { key, ...next }, requestId }, requestId);
}

async function listSystemConfigs(env: AdminApiEnv, requestId: string): Promise<Response> {
  const result = await env.DB.prepare(`SELECT id, config_key AS configKey, version, status, value_json AS valueJson,
    created_by_email AS createdByEmail, created_at AS createdAt FROM system_config_versions
    WHERE deleted_at IS NULL
    ORDER BY config_key, version DESC`).all<Record<string, unknown>>();
  return json({ items: (result.results ?? []).map((row) => ({ ...row, value: JSON.parse(String(row.valueJson)), valueJson: undefined })), requestId }, requestId);
}

async function deleteSystemConfig(env: AdminApiEnv, id: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const current = await env.DB.prepare(`SELECT id, config_key AS configKey, version, status, value_json AS valueJson
    FROM system_config_versions WHERE id = ?1 AND deleted_at IS NULL`).bind(id).first<Record<string, unknown>>();
  if (!current) throw new ApiError(404, "not_found", "System configuration version not found");
  const fallback = current.status === "active" ? await env.DB.prepare(`SELECT id, version FROM system_config_versions
    WHERE config_key = ?1 AND id <> ?2 AND status = 'archived' AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`)
    .bind(current.configKey, id).first<{ id: string; version: number }>() : null;
  const statements = [
    env.DB.prepare("UPDATE system_config_versions SET status = 'archived', deleted_at = ?1 WHERE id = ?2").bind(timestamp(), id),
  ];
  if (fallback) statements.push(env.DB.prepare("UPDATE system_config_versions SET status = 'active' WHERE id = ?1").bind(fallback.id));
  await env.DB.batch(statements);
  return json({ data: { id, deleted: true, fallbackVersionId: fallback?.id ?? null }, requestId }, requestId);
}

function validateSystemConfig(key: string, value: Record<string, unknown>): Record<string, unknown> {
  if (key === "classification_threshold") {
    const minimumConfidence = Number(value.minimumConfidence);
    if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) throw new ApiError(422, "validation_failed", "minimumConfidence must be between 0 and 1");
    return { minimumConfidence };
  }
  if (key === "classification_sampling") {
    const budget = Number(value.bodyTokenBudget); const windows = Number(value.middleWindows);
    if (!Number.isInteger(budget) || budget < 500 || budget > 8000 || !Number.isInteger(windows) || windows < 1 || windows > 8) {
      throw new ApiError(422, "validation_failed", "Sampling budget or middle window count is invalid");
    }
    return { algorithmVersion: "paragraph-dispersed-v1", bodyTokenBudget: budget, headRatio: 0.25,
      middleRatio: 0.6, tailRatio: 0.15, middleWindows: windows, minimumBudget: 500, maximumBudget: 8000 };
  }
  if (key === "translation_limits") {
    const batchTokenBudget = Number(value.batchTokenBudget); const maxRetries = Number(value.maxRetries); const baseRetrySeconds = Number(value.baseRetrySeconds);
    if (!Number.isInteger(batchTokenBudget) || batchTokenBudget < 500 || batchTokenBudget > 12000 ||
      !Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > 5 || !Number.isInteger(baseRetrySeconds) || baseRetrySeconds < 5 || baseRetrySeconds > 3600) {
      throw new ApiError(422, "validation_failed", "Translation limits are invalid");
    }
    return { batchTokenBudget, maxRetries, baseRetrySeconds };
  }
  throw new ApiError(404, "not_found", "System configuration key not found");
}

async function publishSystemConfig(request: Request, env: AdminApiEnv, key: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const input = await body(request);
  if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value)) throw new ApiError(422, "validation_failed", "value must be an object");
  const value = validateSystemConfig(key, input.value as Record<string, unknown>);
  const previous = await env.DB.prepare(`SELECT id, version, value_json AS valueJson FROM system_config_versions
    WHERE config_key = ?1 AND status = 'active'`).bind(key).first<Record<string, unknown>>();
  const maximum = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM system_config_versions WHERE config_key = ?1")
    .bind(key).first<{ version: number }>();
  const id = crypto.randomUUID(); const version = Number(maximum?.version ?? 0) + 1;
  await env.DB.batch([
    env.DB.prepare("UPDATE system_config_versions SET status = 'archived' WHERE config_key = ?1 AND status = 'active'").bind(key),
    env.DB.prepare(`INSERT INTO system_config_versions
      (id, config_key, version, status, value_json, created_by_subject, created_by_email, created_at)
      VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7)`).bind(id, key, version, JSON.stringify(value), identity.subject, identity.email, timestamp()),
  ]);
  return json({ data: { id, configKey: key, version, status: "active", value }, requestId }, requestId, 201);
}

async function usageStats(env: AdminApiEnv, requestId: string): Promise<Response> {
  const summary = await env.DB.prepare(`SELECT purpose, provider, model, COUNT(*) AS calls,
    SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
    SUM(thinking_tokens) AS thinkingTokens, SUM(latency_ms) AS latencyMs,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
    FROM ai_usage_events WHERE created_at >= datetime('now', '-30 days')
    GROUP BY purpose, provider, model ORDER BY calls DESC`).all();
  const daily = await env.DB.prepare(`SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS calls,
    SUM(input_tokens + output_tokens + thinking_tokens) AS totalTokens
    FROM ai_usage_events WHERE created_at >= datetime('now', '-30 days') GROUP BY substr(created_at, 1, 10) ORDER BY date`).all();
  return json({ data: { periodDays: 30, summary: summary.results ?? [], daily: daily.results ?? [] }, requestId }, requestId);
}

async function translationTask(env: AdminApiEnv, id: string, requestId: string): Promise<Response> {
  const task = await env.DB.prepare(`SELECT t.*, a.title AS articleTitle FROM translations t JOIN articles a ON a.id = t.article_id WHERE t.id = ?1`)
    .bind(id).first<Record<string, unknown>>();
  if (!task) throw new ApiError(404, "not_found", "Translation task not found");
  const [attempts, batches, diagnostics] = await Promise.all([
    env.DB.prepare(`SELECT * FROM translation_attempts WHERE translation_id = ?1 ORDER BY attempt DESC`).bind(id).all(),
    env.DB.prepare(`SELECT b.* FROM translation_batches b
      JOIN translation_attempts x ON x.id = b.attempt_id
      WHERE x.translation_id = ?1 ORDER BY x.attempt DESC, b.batch_index`).bind(id).all(),
    env.DB.prepare(`SELECT id, attempt_id AS attemptId, batch_index AS batchIndex,
      failure_stage AS failureStage, provider_response_key AS providerResponseKey,
      error_code AS errorCode, error_message AS errorMessage, created_at AS createdAt
      FROM translation_diagnostics WHERE translation_id = ?1 ORDER BY created_at DESC LIMIT 50`).bind(id).all<Record<string, unknown>>(),
  ]);
  const diagnosticItems = await Promise.all((diagnostics.results ?? []).map(async (item) => {
    const object = await env.CONTENT.get(String(item.providerResponseKey));
    return { ...item, providerResponse: object ? await object.text() : null, providerResponseKey: undefined };
  }));
  return json({ data: {
    task,
    attempts: attempts.results ?? [],
    batches: batches.results ?? [],
    diagnostics: diagnosticItems,
  }, requestId }, requestId);
}

function profileFromInput(input: Record<string, unknown>, id: string, version: number): AiProfileConfig {
  if ("contextWindowTokens" in input || "context_window_tokens" in input || "canonicalModel" in input ||
      "canonical_model" in input || "modelMetadataFetchedAt" in input || "model_metadata_fetched_at" in input) {
    throw new ApiError(422, "validation_failed", "OpenRouter model metadata is read-only");
  }
  let parameters: Record<string, unknown> = {};
  if (input.parameters !== undefined) {
    if (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters)) {
      throw new ApiError(422, "validation_failed", "parameters must be an object");
    }
    parameters = input.parameters as Record<string, unknown>;
  }
  try {
    return validateProfile({
      id,
      profile: string(input.profile, "profile", 20) as AiProfileConfig["profile"],
      provider: "openrouter",
      endpoint: OPENROUTER_ENDPOINT,
      model: string(input.model, "model", 200),
      maxOutputTokens: input.maxOutputTokens == null || input.maxOutputTokens === ""
        ? null
        : Number(input.maxOutputTokens),
      thinkingEnabled: false,
      parameters,
    });
  } catch (cause) {
    throw new ApiError(422, "validation_failed", cause instanceof Error ? cause.message : "AI profile is invalid");
  }
}

interface ModelMetadata {
  canonicalModel: string;
  contextWindowTokens: number;
  fetchedAt: string;
}

async function requestModelMetadata(env: AdminApiEnv, model: string): Promise<ModelMetadata> {
  const response = await env.AI_SERVICE.fetch("https://feedmind-ai-service.internal/model-metadata", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
  });
  if (!response.ok) {
    let message = "Unable to load OpenRouter model metadata";
    try {
      const payload = await response.json() as { error?: { message?: unknown } };
      if (typeof payload.error?.message === "string") message = payload.error.message;
    } catch { /* keep safe message */ }
    throw new ApiError(422, "model_metadata_unavailable", message);
  }
  const payload = await response.json() as { data?: Partial<ModelMetadata> };
  const data = payload.data;
  if (!data || !Number.isSafeInteger(data.contextWindowTokens) || Number(data.contextWindowTokens) <= 0 ||
      typeof data.canonicalModel !== "string" || !data.canonicalModel || typeof data.fetchedAt !== "string") {
    throw new ApiError(422, "model_metadata_unavailable", "OpenRouter model metadata is invalid");
  }
  return data as ModelMetadata;
}

async function listProfiles(env: AdminApiEnv, requestId: string): Promise<Response> {
  const result = await env.DB.prepare(`SELECT id, profile, version, status, provider, endpoint, model,
    context_window_tokens AS contextWindowTokens, canonical_model AS canonicalModel,
    model_metadata_fetched_at AS modelMetadataFetchedAt,
    region, workspace_id AS workspaceId, max_output_tokens AS maxOutputTokens,
    thinking_enabled AS thinkingEnabled, parameters_json AS parametersJson,
    created_by_email AS createdByEmail, created_at AS createdAt
    FROM ai_profile_versions WHERE provider = 'openrouter' AND deleted_at IS NULL ORDER BY profile, version DESC`).all<Record<string, unknown>>();
  return json({ items: (result.results ?? []).map((row) => ({
    ...row,
    thinkingEnabled: row.thinkingEnabled === 1,
    parameters: JSON.parse(String(row.parametersJson ?? "{}")),
    parametersJson: undefined,
  })), requestId }, requestId);
}

async function createProfile(request: Request, env: AdminApiEnv, requestId: string, identity: AccessIdentity): Promise<Response> {
  const input = await body(request);
  const profileName = string(input.profile, "profile", 20);
  const maximum = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM ai_profile_versions WHERE profile = ?1")
    .bind(profileName).first<{ version: number }>();
  const version = Number(maximum?.version ?? 0) + 1;
  const id = crypto.randomUUID();
  const profile = profileFromInput(input, id, version);
  const metadata = await requestModelMetadata(env, profile.model);
  const now = timestamp();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ai_profile_versions
      (id, profile, version, status, provider, protocol, endpoint, model, region, workspace_id,
       max_output_tokens, thinking_enabled, parameters_json, context_window_tokens, canonical_model,
       model_metadata_fetched_at, created_by_subject, created_by_email, created_at)
      VALUES (?1, ?2, ?3, 'draft', ?4, 'chat_completions', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`)
      .bind(id, profile.profile, version, profile.provider, profile.endpoint, profile.model, null,
        null, profile.maxOutputTokens, 0, JSON.stringify(profile.parameters), metadata.contextWindowTokens,
        metadata.canonicalModel, metadata.fetchedAt, identity.subject, identity.email, now),
  ]);
  return json({ data: { id, profile: profile.profile, version, status: "draft", ...metadata }, requestId }, requestId, 201);
}

async function readProfile(env: AdminApiEnv, id: string): Promise<AiProfileConfig | null> {
  const row = await env.DB.prepare(`SELECT id, profile, provider, endpoint, model,
    context_window_tokens AS contextWindowTokens, canonical_model AS canonicalModel,
    model_metadata_fetched_at AS modelMetadataFetchedAt,
    max_output_tokens AS maxOutputTokens, thinking_enabled AS thinkingEnabled, parameters_json AS parametersJson
    FROM ai_profile_versions WHERE id = ?1 AND deleted_at IS NULL`).bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  return validateProfile({
    id: String(row.id), profile: row.profile as AiProfileConfig["profile"], provider: row.provider as AiProfileConfig["provider"],
    endpoint: String(row.endpoint), model: String(row.model),
    contextWindowTokens: row.contextWindowTokens == null ? null : Number(row.contextWindowTokens),
    canonicalModel: row.canonicalModel == null ? null : String(row.canonicalModel),
    modelMetadataFetchedAt: row.modelMetadataFetchedAt == null ? null : String(row.modelMetadataFetchedAt),
    maxOutputTokens: row.maxOutputTokens == null ? null : Number(row.maxOutputTokens),
    thinkingEnabled: row.thinkingEnabled === 1,
    parameters: JSON.parse(String(row.parametersJson ?? "{}")),
  });
}

async function throwProfileTestFailure(response: Response): Promise<never> {
  let detail = "AI profile connectivity or model permission test failed";
  try {
    const payload = await response.json() as { error?: { message?: unknown } };
    const upstream = payload.error?.message;
    if (upstream === "OpenRouter API key is not configured" ||
        (typeof upstream === "string" && /^AI upstream HTTP \d{3}: [^\r\n]{1,500}$/.test(upstream))) detail = upstream;
  } catch {
    // Preserve the generic message when the internal service response is not JSON.
  }
  throw new ApiError(422, "ai_profile_test_failed", detail);
}

async function requestProfileTest(env: AdminApiEnv, profile: AiProfileConfig): Promise<Response> {
  const response = await env.AI_SERVICE.fetch("https://feedmind-ai-service.internal/test", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: profile,
      input: { profile: profile.profile, system: "Connectivity test. Reply with OK only.", messages: [{ role: "user", content: "OK" }] },
    }),
  });
  if (!response.ok) await throwProfileTestFailure(response);
  return response;
}

async function updateProfile(
  request: Request,
  env: AdminApiEnv,
  id: string,
  requestId: string,
  identity: AccessIdentity,
): Promise<Response> {
  const current = await env.DB.prepare(`SELECT id, profile, version, status, provider, endpoint, model,
    max_output_tokens AS maxOutputTokens, parameters_json AS parametersJson
    FROM ai_profile_versions WHERE id = ?1 AND provider = 'openrouter' AND deleted_at IS NULL`)
    .bind(id).first<Record<string, unknown>>();
  if (!current) throw new ApiError(404, "not_found", "AI profile version not found");
  const input = await body(request);
  const profile = profileFromInput({ ...input, profile: current.profile }, id, Number(current.version));
  const metadata = await requestModelMetadata(env, profile.model);
  if (current.status === "active") await requestProfileTest(env, profile);
  const next = {
    provider: profile.provider,
    endpoint: profile.endpoint,
    model: profile.model,
    maxOutputTokens: profile.maxOutputTokens,
    parameters: profile.parameters,
  };
  await env.DB.batch([
    env.DB.prepare(`UPDATE ai_profile_versions SET provider = ?1, protocol = 'chat_completions', endpoint = ?2,
      model = ?3, region = NULL, workspace_id = NULL, max_output_tokens = ?4, thinking_enabled = 0,
      parameters_json = ?5, context_window_tokens = ?6, canonical_model = ?7,
      model_metadata_fetched_at = ?8 WHERE id = ?9`)
      .bind(profile.provider, profile.endpoint, profile.model, profile.maxOutputTokens, JSON.stringify(profile.parameters),
        metadata.contextWindowTokens, metadata.canonicalModel, metadata.fetchedAt, id),
  ]);
  return json({ data: {
    id, profile: profile.profile, version: Number(current.version), status: String(current.status), ...next,
    ...metadata,
  }, requestId }, requestId);
}

async function deleteProfile(env: AdminApiEnv, id: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const current = await env.DB.prepare(`SELECT id, profile, version, status, provider, model
    FROM ai_profile_versions WHERE id = ?1 AND deleted_at IS NULL`).bind(id).first<Record<string, unknown>>();
  if (!current) throw new ApiError(404, "not_found", "AI profile version not found");
  const fallback = current.status === "active" ? await env.DB.prepare(`SELECT id, version FROM ai_profile_versions
    WHERE profile = ?1 AND id <> ?2 AND provider = 'openrouter' AND status = 'archived'
      AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`)
    .bind(current.profile, id).first<{ id: string; version: number }>() : null;
  const statements = [
    env.DB.prepare("UPDATE ai_profile_versions SET status = 'archived', deleted_at = ?1 WHERE id = ?2").bind(timestamp(), id),
  ];
  if (fallback) statements.push(env.DB.prepare("UPDATE ai_profile_versions SET status = 'active' WHERE id = ?1").bind(fallback.id));
  await env.DB.batch(statements);
  return json({ data: { id, deleted: true, fallbackVersionId: fallback?.id ?? null }, requestId }, requestId);
}

async function publishProfile(request: Request, env: AdminApiEnv, id: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const profile = await readProfile(env, id);
  if (!profile) throw new ApiError(404, "not_found", "AI profile version not found");
  const metadata = await requestModelMetadata(env, profile.model);
  await requestProfileTest(env, profile);
  await env.DB.batch([
    env.DB.prepare("UPDATE ai_profile_versions SET status = 'archived' WHERE profile = ?1 AND status = 'active'").bind(profile.profile),
    env.DB.prepare(`UPDATE ai_profile_versions SET status = 'active', context_window_tokens = ?1,
      canonical_model = ?2, model_metadata_fetched_at = ?3 WHERE id = ?4`)
      .bind(metadata.contextWindowTokens, metadata.canonicalModel, metadata.fetchedAt, id),
  ]);
  return json({ data: { id, profile: profile.profile, status: "active", ...metadata }, requestId }, requestId);
}

async function testProfile(env: AdminApiEnv, id: string, requestId: string): Promise<Response> {
  const profile = await readProfile(env, id);
  if (!profile) throw new ApiError(404, "not_found", "AI profile version not found");
  const response = await requestProfileTest(env, profile);
  const result = await response.json() as { data?: { usage?: Record<string, unknown>; latencyMs?: unknown }; [key: string]: unknown };
  const usage = result.data?.usage ?? {};
  await env.DB.prepare(`INSERT INTO ai_usage_events
    (id, purpose, profile_version_id, provider, model, status, input_tokens, output_tokens, thinking_tokens,
     latency_ms, request_id, created_at) VALUES (?1, 'profile_test', ?2, ?3, ?4, 'completed', ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(crypto.randomUUID(), profile.id, profile.provider, profile.model, Number(usage.inputTokens ?? 0),
      Number(usage.outputTokens ?? 0), Number(usage.thinkingTokens ?? 0), Number(result.data?.latencyMs ?? 0), requestId, timestamp()).run();
  return json({ ...result, requestId }, requestId);
}

async function backfillProfileMetadata(env: AdminApiEnv, requestId: string): Promise<Response> {
  const profiles = await env.DB.prepare(`SELECT id, model FROM ai_profile_versions
    WHERE provider = 'openrouter' AND deleted_at IS NULL AND context_window_tokens IS NULL
    ORDER BY created_at LIMIT 50`).all<{ id: string; model: string }>();
  let updated = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const profile of profiles.results ?? []) {
    try {
      const metadata = await requestModelMetadata(env, profile.model);
      await env.DB.prepare(`UPDATE ai_profile_versions SET context_window_tokens = ?1, canonical_model = ?2,
        model_metadata_fetched_at = ?3 WHERE id = ?4`)
        .bind(metadata.contextWindowTokens, metadata.canonicalModel, metadata.fetchedAt, profile.id).run();
      updated++;
    } catch (error) {
      failures.push({ id: profile.id, error: error instanceof Error ? error.message.slice(0, 300) : "metadata_failed" });
    }
  }
  return json({ data: { scanned: profiles.results?.length ?? 0, updated, failures }, requestId }, requestId);
}

async function listTopicTags(env: AdminApiEnv, requestId: string): Promise<Response> {
  const result = await env.DB.prepare(`SELECT id, tag_key AS key, status, names_json AS namesJson,
    aliases_json AS aliasesJson, vocabulary_version AS vocabularyVersion, created_at AS createdAt,
    updated_at AS updatedAt FROM topic_tags ORDER BY status, tag_key`).all<Record<string, unknown>>();
  return json({ items: (result.results ?? []).map((row) => ({ ...row,
    names: JSON.parse(String(row.namesJson ?? "{}")), aliases: JSON.parse(String(row.aliasesJson ?? "[]")),
    namesJson: undefined, aliasesJson: undefined,
  })), requestId }, requestId);
}

async function updateTopicTag(request: Request, env: AdminApiEnv, id: string, requestId: string): Promise<Response> {
  const input = await body(request);
  const status = string(input.status, "status", 20);
  if (!["active", "deprecated"].includes(status)) throw new ApiError(422, "validation_failed", "status is invalid");
  const names = input.names;
  const aliases = input.aliases ?? [];
  if (!names || typeof names !== "object" || Array.isArray(names) || !Array.isArray(aliases) ||
      aliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
    throw new ApiError(422, "validation_failed", "Tag names or aliases are invalid");
  }
  for (const locale of ["zh-CN", "en-US", "ja-JP"]) string((names as Record<string, unknown>)[locale], `names.${locale}`, 100);
  await env.DB.prepare(`UPDATE topic_tags SET status = ?1, names_json = ?2, aliases_json = ?3,
    vocabulary_version = vocabulary_version + 1, updated_at = ?4 WHERE id = ?5`)
    .bind(status, JSON.stringify(names), JSON.stringify(aliases.map((alias) => alias.trim())), timestamp(), id).run();
  return json({ data: { id, status }, requestId }, requestId);
}

async function listTranslationTasks(env: AdminApiEnv, requestId: string): Promise<Response> {
  const result = await env.DB.prepare(`SELECT t.id, t.article_id AS articleId, a.title AS articleTitle,
    t.target_locale AS targetLocale, t.article_type AS articleType, t.status, t.source_hash AS sourceHash,
    t.retry_count AS retryCount, t.workflow_instance_id AS workflowInstanceId,
    t.parent_translation_id AS parentTranslationId, t.trigger_reason AS triggerReason,
    t.created_by AS createdBy, t.created_at AS createdAt, t.started_at AS startedAt, t.completed_at AS completedAt,
    pv.id AS promptVersionId, pv.version AS promptVersion, pv.content AS promptContent,
    bp.id AS bodyProfileVersionId, bp.profile AS bodyProfile, bp.version AS bodyProfileVersion,
    bp.provider AS bodyProvider, bp.protocol AS bodyProtocol, bp.endpoint AS bodyEndpoint, bp.model AS bodyModel,
    bp.region AS bodyRegion, bp.workspace_id AS bodyWorkspaceId, bp.max_output_tokens AS bodyMaxOutputTokens,
    bp.thinking_enabled AS bodyThinkingEnabled, bp.parameters_json AS bodyParametersJson,
    tp.id AS titleProfileVersionId, tp.profile AS titleProfile, tp.version AS titleProfileVersion,
    tp.provider AS titleProvider, tp.protocol AS titleProtocol, tp.endpoint AS titleEndpoint, tp.model AS titleModel,
    tp.region AS titleRegion, tp.workspace_id AS titleWorkspaceId, tp.max_output_tokens AS titleMaxOutputTokens,
    tp.thinking_enabled AS titleThinkingEnabled, tp.parameters_json AS titleParametersJson,
    (SELECT COUNT(*) FROM translation_diagnostics z WHERE z.translation_id = t.id) AS diagnosticCount,
    (SELECT error_code FROM translation_attempts x WHERE x.translation_id = t.id ORDER BY attempt DESC LIMIT 1) AS errorCode,
    (SELECT error_message FROM translation_attempts x WHERE x.translation_id = t.id ORDER BY attempt DESC LIMIT 1) AS errorMessage
    FROM translations t
    JOIN articles a ON a.id = t.article_id
    LEFT JOIN prompt_versions pv ON pv.id = t.prompt_version_id
    LEFT JOIN ai_profile_versions bp ON bp.id = t.body_profile_version_id
    LEFT JOIN ai_profile_versions tp ON tp.id = t.title_profile_version_id
    ORDER BY t.created_at DESC LIMIT 500`).all<Record<string, unknown>>();
  const profileSnapshot = (row: Record<string, unknown>, prefix: "body" | "title") => ({
    id: row[`${prefix}ProfileVersionId`],
    profile: row[`${prefix}Profile`],
    version: row[`${prefix}ProfileVersion`],
    provider: row[`${prefix}Provider`],
    protocol: row[`${prefix}Protocol`],
    endpoint: row[`${prefix}Endpoint`],
    model: row[`${prefix}Model`],
    region: row[`${prefix}Region`],
    workspaceId: row[`${prefix}WorkspaceId`],
    maxOutputTokens: row[`${prefix}MaxOutputTokens`],
    thinkingEnabled: row[`${prefix}ThinkingEnabled`] === 1,
    parameters: JSON.parse(String(row[`${prefix}ParametersJson`] ?? "{}")),
  });
  const items = (result.results ?? []).map((row) => {
    const prompt = { id: row.promptVersionId, version: row.promptVersion, content: row.promptContent };
    const bodyModelConfig = profileSnapshot(row, "body");
    const titleModelConfig = profileSnapshot(row, "title");
    const omitted = [
      "promptVersion", "promptContent",
      "bodyProfile", "bodyProfileVersion", "bodyProvider", "bodyProtocol", "bodyEndpoint", "bodyModel",
      "bodyRegion", "bodyWorkspaceId", "bodyMaxOutputTokens", "bodyThinkingEnabled", "bodyParametersJson",
      "titleProfile", "titleProfileVersion", "titleProvider", "titleProtocol", "titleEndpoint", "titleModel",
      "titleRegion", "titleWorkspaceId", "titleMaxOutputTokens", "titleThinkingEnabled", "titleParametersJson",
    ];
    const task = { ...row };
    omitted.forEach((key) => delete task[key]);
    return { ...task, prompt, bodyModelConfig, titleModelConfig };
  });
  return json({ items, requestId }, requestId);
}

async function createAdminTranslation(
  request: Request,
  env: AdminApiEnv,
  articleId: string,
  requestId: string,
  identity: AccessIdentity,
): Promise<Response> {
  const input = await body(request);
  const targetLocale = input.targetLocale == null ? "zh-CN" : string(input.targetLocale, "targetLocale", 35);
  const parentId = input.parentTranslationId == null ? null : string(input.parentTranslationId, "parentTranslationId", 100);
  const classifiedArticle = await env.DB.prepare(`SELECT a.source_hash AS sourceHash, c.article_type AS articleType,
    COALESCE(tt.translated_title, c.translated_title, a.title) AS translatedTitle,
    c.title_profile_version_id AS titleProfileVersionId
    FROM articles a JOIN article_classifications c
      ON c.article_id = a.id AND c.source_hash = a.source_hash AND c.is_current = 1
    LEFT JOIN article_title_translations tt ON tt.classification_id = c.id AND tt.target_locale = ?2
    WHERE a.id = ?1 AND a.parse_status = 'completed'`).bind(articleId, targetLocale).first<{
      sourceHash: string; articleType: string; translatedTitle: string; titleProfileVersionId: string;
    }>();
  if (!classifiedArticle) {
    throw new ApiError(409, "article_classification_unavailable", "Article must be classified before translation");
  }
  const translationConfig = await env.DB.prepare(`SELECT p.id AS promptVersionId, q.id AS bodyProfileVersionId
    FROM prompt_definitions d
    JOIN prompt_versions p ON p.id = d.current_version_id AND p.status = 'active'
    JOIN ai_profile_versions q ON q.profile = 'quality' AND q.provider = 'openrouter' AND q.status = 'active'
    WHERE d.task = 'body_translation' AND d.article_type = ?1
      AND d.target_locale = ?2 AND d.deleted_at IS NULL`).bind(classifiedArticle.articleType, targetLocale).first<{
      promptVersionId: string; bodyProfileVersionId: string;
    }>();
  if (!translationConfig) {
    throw new ApiError(409, "translation_configuration_unavailable", `No active translation prompt is configured for ${classifiedArticle.articleType}`);
  }
  const context = { ...classifiedArticle, ...translationConfig };
  const active = await env.DB.prepare(`SELECT id FROM translations WHERE article_id = ?1 AND target_locale = ?2
    AND source_hash = ?3 AND status IN ('pending', 'running', 'cancel_requested')`).bind(articleId, targetLocale, context.sourceHash)
    .first<{ id: string }>();
  if (active) throw new ApiError(409, "translation_active", "An active translation already exists for this article version");
  const translationId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const created = timestamp();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO translations
      (id, owner_id, article_id, target_locale, article_type, status, source_hash, translated_title,
       prompt_version_id, title_profile_version_id, body_profile_version_id, parent_translation_id,
       trigger_reason, retry_count, created_by, created_by_subject, request_id, created_at)
      VALUES (?1, 'owner', ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10,
        'admin_retranslate', 0, 'admin', ?11, ?12, ?13)`)
      .bind(translationId, articleId, targetLocale, context.articleType, context.sourceHash, context.translatedTitle,
        context.promptVersionId, context.titleProfileVersionId, context.bodyProfileVersionId,
        parentId, identity.subject, requestId, created),
    env.DB.prepare(`INSERT INTO translation_attempts
      (id, translation_id, attempt, status, created_at) VALUES (?1, ?2, 1, 'pending', ?3)`)
      .bind(attemptId, translationId, created),
  ]);
  const workflow = await env.BODY_TRANSLATION_WORKFLOW.create({
    id: `translation-${translationId}-attempt-1`, params: { translationId, attemptId, requestId },
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE translations SET workflow_instance_id = ?1 WHERE id = ?2").bind(workflow.id, translationId),
    env.DB.prepare("UPDATE translation_attempts SET workflow_instance_id = ?1 WHERE id = ?2").bind(workflow.id, attemptId),
  ]);
  return json({ data: { translationId, attemptId, workflowInstanceId: workflow.id, status: "pending" }, requestId }, requestId, 202);
}

async function retryTranslation(env: AdminApiEnv, id: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const translation = await env.DB.prepare(`SELECT status, workflow_instance_id AS workflowInstanceId
    FROM translations WHERE id = ?1`).bind(id).first<{ status: string; workflowInstanceId: string | null }>();
  if (!translation) throw new ApiError(404, "not_found", "Translation not found");
  if (!["failed", "cancelled", "superseded"].includes(translation.status)) {
    throw new ApiError(409, "translation_not_retryable", "Translation is not in a retryable state");
  }
  const previous = await env.DB.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM translation_attempts WHERE translation_id = ?1")
    .bind(id).first<{ attempt: number }>();
  const attempt = Number(previous?.attempt ?? 0) + 1;
  const attemptId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`UPDATE translations SET status = 'pending', retry_count = retry_count + 1,
      workflow_instance_id = NULL, started_at = NULL, completed_at = NULL WHERE id = ?1`).bind(id),
    env.DB.prepare(`INSERT INTO translation_attempts
      (id, translation_id, attempt, status, created_at) VALUES (?1, ?2, ?3, 'pending', ?4)`)
      .bind(attemptId, id, attempt, timestamp()),
  ]);
  const workflow = await env.BODY_TRANSLATION_WORKFLOW.create({
    id: `translation-${id}-attempt-${attempt}`, params: { translationId: id, attemptId, requestId },
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE translations SET workflow_instance_id = ?1 WHERE id = ?2").bind(workflow.id, id),
    env.DB.prepare("UPDATE translation_attempts SET workflow_instance_id = ?1 WHERE id = ?2").bind(workflow.id, attemptId),
  ]);
  return json({ data: { translationId: id, attemptId, workflowInstanceId: workflow.id, status: "pending" }, requestId }, requestId, 202);
}

async function restartTranslation(env: AdminApiEnv, id: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const translation = await env.DB.prepare(`SELECT status, workflow_instance_id AS workflowInstanceId
    FROM translations WHERE id = ?1`).bind(id).first<{ status: string; workflowInstanceId: string | null }>();
  if (!translation?.workflowInstanceId) throw new ApiError(404, "workflow_not_found", "Translation workflow instance not found");
  if (translation.status === "completed") throw new ApiError(409, "translation_completed", "Completed translations must not be restarted");
  const instance = await env.BODY_TRANSLATION_WORKFLOW.get(translation.workflowInstanceId);
  await instance.restart();
  await env.DB.prepare("UPDATE translations SET status = 'pending', completed_at = NULL WHERE id = ?1").bind(id).run();
  return json({ data: { translationId: id, workflowInstanceId: translation.workflowInstanceId, status: "pending" }, requestId }, requestId, 202);
}

async function cancelTranslation(env: AdminApiEnv, id: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const translation = await env.DB.prepare(`SELECT status, workflow_instance_id AS workflowInstanceId
    FROM translations WHERE id = ?1`).bind(id).first<{ status: string; workflowInstanceId: string | null }>();
  if (!translation) throw new ApiError(404, "not_found", "Translation not found");
  if (!["pending", "running", "cancel_requested"].includes(translation.status)) {
    throw new ApiError(409, "translation_not_active", "Translation is not active");
  }
  await env.DB.prepare("UPDATE translations SET status = 'cancel_requested', cancel_requested_at = ?1 WHERE id = ?2")
    .bind(timestamp(), id).run();
  if (translation.workflowInstanceId) {
    try { await (await env.BODY_TRANSLATION_WORKFLOW.get(translation.workflowInstanceId)).terminate(); } catch { /* state is still cancellable */ }
  }
  await env.DB.prepare("UPDATE translations SET status = 'cancelled', completed_at = ?1 WHERE id = ?2").bind(timestamp(), id).run();
  return json({ data: { translationId: id, status: "cancelled" }, requestId }, requestId);
}

async function reparseArticle(env: AdminApiEnv, articleId: string, requestId: string, identity: AccessIdentity, failedOnly = false): Promise<Response> {
  const article = await env.DB.prepare("SELECT canonical_url AS url, parse_status AS parseStatus FROM articles WHERE id = ?1")
    .bind(articleId).first<{ url: string; parseStatus: string }>();
  if (!article) throw new ApiError(404, "not_found", "Article not found");
  if (failedOnly && article.parseStatus !== "failed") {
    throw new ApiError(409, "article_parse_not_failed", "Only a failed article can use parse-retry");
  }
  const active = await env.DB.prepare("SELECT id FROM article_parse_tasks WHERE article_id = ?1 AND status IN ('pending', 'running')")
    .bind(articleId).first<{ id: string }>();
  if (active) throw new ApiError(409, "parse_task_active", "An article parse task is already active");
  const taskId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("UPDATE articles SET parse_status = 'pending', parse_error = NULL, updated_at = ?1 WHERE id = ?2")
      .bind(timestamp(), articleId),
    env.DB.prepare(`INSERT INTO article_parse_tasks
      (id, article_id, source_url, status, requested_by, requested_by_subject, request_id, created_at)
      VALUES (?1, ?2, ?3, 'pending', 'admin', ?4, ?5, ?6)`)
      .bind(taskId, articleId, article.url, identity.subject, requestId, timestamp()),
  ]);
  await env.ARTICLE_QUEUE.send({ articleId, requestId, reason: "admin_reparse" }, { contentType: "json" });
  return json({ data: { articleId, taskId, status: "pending" }, requestId }, requestId, 202);
}

async function reclassifyArticle(env: AdminApiEnv, articleId: string, requestId: string, identity: AccessIdentity): Promise<Response> {
  const article = await env.DB.prepare(`SELECT source_hash AS sourceHash, source_text_hash AS sourceTextHash,
    parse_status AS parseStatus FROM articles WHERE id = ?1`)
    .bind(articleId).first<{ sourceHash: string | null; sourceTextHash: string | null; parseStatus: string }>();
  if (!article?.sourceHash || !article.sourceTextHash || article.parseStatus !== "completed") {
    throw new ApiError(409, "article_not_parsed", "Article source text is not ready");
  }
  const taskId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO article_preprocessing_tasks
    (id, article_id, source_hash, source_text_hash, status, requested_by, requested_by_subject, request_id, created_at)
    VALUES (?1, ?2, ?3, ?4, 'pending', 'admin', ?5, ?6, ?7)`)
    .bind(taskId, articleId, article.sourceHash, article.sourceTextHash, identity.subject, requestId, timestamp()).run();
  const workflow = await env.CLASSIFICATION_WORKFLOW.create({
    id: `class-admin-${articleId}-${crypto.randomUUID().slice(0, 12)}`,
    params: { articleId, sourceHash: article.sourceHash, sourceTextHash: article.sourceTextHash, requestId, taskId },
  });
  await env.DB.prepare("UPDATE article_preprocessing_tasks SET workflow_instance_id = ?1 WHERE id = ?2")
    .bind(workflow.id, taskId).run();
  return json({ data: { articleId, taskId, workflowInstanceId: workflow.id, status: "pending" }, requestId }, requestId, 202);
}

export async function routeAdminApi(
  request: Request,
  env: AdminApiEnv,
  requestId: string,
  identity: AccessIdentity,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/admin/v1" || url.pathname.startsWith("/admin/v1/")) {
    url.pathname = `/v1/admin${url.pathname.slice("/admin/v1".length)}`;
    request = new Request(url, request);
  }
  if (url.pathname === "/v1/admin/article-types" && request.method === "GET") return listArticleTypes(env, requestId);
  if (url.pathname === "/v1/admin/feeds") {
    if (request.method === "GET") return listFeeds(request, env, requestId);
    if (request.method === "POST") return addFeed(request, env, requestId, identity);
  }
  const extractionRule = url.pathname.match(/^\/v1\/admin\/feeds\/([^/]+)\/extraction-rule(?:\/(draft|preview|confirm|publish|rollback|samples))?(?:\/([^/]+))?$/);
  if (extractionRule) {
    const feedId = decodeURIComponent(extractionRule[1]);
    const action = extractionRule[2];
    if (!action && request.method === "GET") return getFeedExtractionRule(env, feedId, requestId);
    if (action === "samples" && request.method === "GET") return listFeedExtractionSamples(request, env, feedId, requestId);
    if (action === "draft" && request.method === "POST") return saveFeedExtractionDraft(request, env, feedId, requestId, identity);
    if (action === "draft" && request.method === "DELETE") return abandonFeedExtractionDraft(env, feedId, requestId);
    if (action === "preview" && request.method === "POST") return previewFeedExtractionRule(request, env, feedId, requestId);
    if (action === "confirm" && request.method === "POST") return confirmFeedExtractionPreview(request, env, feedId, requestId, identity);
    if (action === "publish" && request.method === "POST") return publishFeedExtractionDraft(request, env, feedId, requestId);
    if (action === "rollback" && extractionRule[3] && request.method === "POST") {
      return rollbackFeedExtractionRule(env, feedId, decodeURIComponent(extractionRule[3]), requestId);
    }
  }
  const feedOperation = url.pathname.match(/^\/v1\/admin\/feeds\/([^/]+)(?:\/(refresh))?$/);
  if (feedOperation?.[2] === "refresh" && request.method === "POST") return refreshFeed(env, decodeURIComponent(feedOperation[1]), requestId, identity);
  if (feedOperation && !feedOperation[2] && request.method === "DELETE") return deleteFeed(env, decodeURIComponent(feedOperation[1]), requestId, identity);
  if (url.pathname === "/v1/admin/article-parse-progress" && request.method === "GET") return listParseProgress(request, env, requestId);
  const articleType = url.pathname.match(/^\/v1\/admin\/article-types\/([^/]+)$/);
  if (articleType && request.method === "PATCH") return updateArticleType(request, env, decodeURIComponent(articleType[1]), requestId, identity);
  if (url.pathname === "/v1/admin/system-configs" && request.method === "GET") return listSystemConfigs(env, requestId);
  const systemConfig = url.pathname.match(/^\/v1\/admin\/system-configs\/([^/]+)$/);
  if (systemConfig && request.method === "POST") return publishSystemConfig(request, env, decodeURIComponent(systemConfig[1]), requestId, identity);
  const systemConfigVersion = url.pathname.match(/^\/v1\/admin\/system-config-versions\/([^/]+)$/);
  if (systemConfigVersion && request.method === "DELETE") return deleteSystemConfig(env, decodeURIComponent(systemConfigVersion[1]), requestId, identity);
  if (url.pathname === "/v1/admin/usage" && request.method === "GET") return usageStats(env, requestId);
  if (url.pathname === "/v1/admin/prompts") {
    if (request.method === "GET") return listPrompts(env, requestId);
    if (request.method === "POST") return createPrompt(request, env, requestId, identity);
  }
  if (url.pathname === "/v1/admin/prompt-logs" && request.method === "GET") return promptLogs(env, requestId);
  const prompt = url.pathname.match(/^\/v1\/admin\/prompts\/([^/]+)(?:\/(versions|changes|publish|activate|rollback|test))?$/);
  if (prompt) {
    const id = decodeURIComponent(prompt[1]);
    if (prompt[2] === "versions" && request.method === "GET") return listPromptVersions(env, id, requestId);
    if (prompt[2] === "changes" && request.method === "GET") return promptLogs(env, requestId, id);
    if ((prompt[2] === "publish" || prompt[2] === "activate") && request.method === "POST") return publishPrompt(request, env, id, requestId, identity);
    if (prompt[2] === "rollback" && request.method === "POST") return rollbackPrompt(request, env, id, requestId, identity);
    if (prompt[2] === "test" && request.method === "POST") return testPrompt(request, env, id, requestId);
    if (!prompt[2] && request.method === "PATCH") return editPrompt(request, env, id, requestId, identity);
    if (!prompt[2] && request.method === "DELETE") return deletePrompt(request, env, id, requestId, identity);
  }
  if (url.pathname === "/v1/admin/ai-profiles") {
    if (request.method === "GET") return listProfiles(env, requestId);
    if (request.method === "POST") return createProfile(request, env, requestId, identity);
  }
  if (url.pathname === "/v1/admin/ai-profile-versions" && request.method === "POST") {
    return createProfile(request, env, requestId, identity);
  }
  if (url.pathname === "/v1/admin/ai-profiles/backfill-metadata" && request.method === "POST") {
    return backfillProfileMetadata(env, requestId);
  }
  if (url.pathname === "/v1/admin/topic-tags" && request.method === "GET") return listTopicTags(env, requestId);
  const topicTag = url.pathname.match(/^\/v1\/admin\/topic-tags\/([^/]+)$/);
  if (topicTag && request.method === "PATCH") return updateTopicTag(request, env, decodeURIComponent(topicTag[1]), requestId);
  const profileVersion = url.pathname.match(/^\/v1\/admin\/ai-profile-versions\/([^/]+)\/(activate|test)$/);
  if (profileVersion && request.method === "POST") {
    const id = decodeURIComponent(profileVersion[1]);
    return profileVersion[2] === "activate" ? publishProfile(request, env, id, requestId, identity) : testProfile(env, id, requestId);
  }
  const profile = url.pathname.match(/^\/v1\/admin\/ai-profiles\/([^/]+)\/(publish|test)$/);
  if (profile && request.method === "POST") {
    const id = decodeURIComponent(profile[1]);
    return profile[2] === "publish" ? publishProfile(request, env, id, requestId, identity) : testProfile(env, id, requestId);
  }
  const profileDelete = url.pathname.match(/^\/v1\/admin\/ai-profiles\/([^/]+)$/);
  if (profileDelete && request.method === "PATCH") {
    return updateProfile(request, env, decodeURIComponent(profileDelete[1]), requestId, identity);
  }
  if (profileDelete && request.method === "DELETE") return deleteProfile(env, decodeURIComponent(profileDelete[1]), requestId, identity);
  if ((url.pathname === "/v1/admin/translations" || url.pathname === "/v1/admin/tasks") && request.method === "GET") return listTranslationTasks(env, requestId);
  const task = url.pathname.match(/^\/v1\/admin\/(?:tasks|translations)\/([^/]+)$/);
  if (task && request.method === "GET") return translationTask(env, decodeURIComponent(task[1]), requestId);
  const articleOperation = url.pathname.match(/^\/v1\/admin\/articles\/([^/]+)\/(retranslate|reparse|parse-retry|reclassify)$/);
  if (articleOperation && request.method === "POST") {
    const articleId = decodeURIComponent(articleOperation[1]);
    if (articleOperation[2] === "retranslate") return createAdminTranslation(request, env, articleId, requestId, identity);
    if (articleOperation[2] === "reparse") return reparseArticle(env, articleId, requestId, identity);
    if (articleOperation[2] === "parse-retry") return reparseArticle(env, articleId, requestId, identity, true);
    return reclassifyArticle(env, articleId, requestId, identity);
  }
  const translationOperation = url.pathname.match(/^\/v1\/admin\/translations\/([^/]+)\/(retry|restart|cancel)$/);
  if (translationOperation && request.method === "POST") {
    const id = decodeURIComponent(translationOperation[1]);
    if (translationOperation[2] === "retry") return retryTranslation(env, id, requestId, identity);
    if (translationOperation[2] === "restart") return restartTranslation(env, id, requestId, identity);
    return cancelTranslation(env, id, requestId, identity);
  }
  return undefined;
}
