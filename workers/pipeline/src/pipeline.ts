import { parseHTML } from "linkedom";
import { extractArticleWithRule, validateFeedExtractionRule, type FeedExtractionRuleConfig } from "../../../src/utils/extractionRules";
import { fetchContent } from "../../shared/src/content-fetch";
import type {
  D1Database,
  Queue,
  R2Bucket,
  WorkflowBinding,
} from "../../shared/src/cloudflare";
import { parseFeed } from "./feed-parser";
import { persistArticleContentBlocks } from "./content-blocks";
import { CONTENT_BLOCK_INDEX_VERSION, contentHtmlToText } from "../../shared/src/content-blocks";

export const TRANSLATION_DIAGNOSTIC_RETENTION_DAYS = 14;
const ARTICLE_PARSE_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_ARTICLE_PARSE_LEASE_RECOVERIES = 2;
const ARTICLE_HTML_NORMAL_LIMIT_BYTES = 4 << 20;
const ARTICLE_HTML_HARD_LIMIT_BYTES = 16 << 20;
const classificationWorkflowVersion = "preprocess-fulltext-v1";
const classificationWorkflowId = (articleId: string, sourceTextHash: string) =>
  `class-${classificationWorkflowVersion}-${articleId}-${sourceTextHash.slice(0, 16)}`;

export interface FeedMessage {
  feedId: string;
  requestId: string;
  reason?: string;
}

export interface ArticleMessage {
  articleId: string;
  requestId: string;
  reason?: string;
}

export interface SourceQueueMessage {
  connectionId: string;
  sourceId?: string;
  selectionRevision?: number;
  requestId: string;
  reason?: string;
}

export async function backfillArticleContentBlocks(message: ArticleMessage, env: PipelineEnv): Promise<void> {
  const article = await env.DB.prepare(`SELECT id, feed_id AS feedId, source_hash AS sourceHash,
    source_html_key AS sourceHtmlKey FROM articles WHERE id = ?1 AND parse_status = 'completed'`)
    .bind(message.articleId).first<{ id: string; feedId: string | null; sourceHash: string | null; sourceHtmlKey: string | null }>();
  if (!article?.feedId || !article.sourceHash || !article.sourceHtmlKey) return;
  const existing = await env.DB.prepare(`SELECT 1 AS found FROM article_content_blocks
    WHERE article_id = ?1 AND source_hash = ?2 AND policy_version = ?3 LIMIT 1`)
    .bind(article.id, article.sourceHash, CONTENT_BLOCK_INDEX_VERSION).first<{ found: number }>();
  if (existing) return;
  const object = await env.CONTENT.get(article.sourceHtmlKey);
  if (!object) throw new Error("Historical article source HTML is missing");
  await persistArticleContentBlocks(env, {
    articleId: article.id, feedId: article.feedId, sourceHash: article.sourceHash, html: await object.text(),
  });
}

export interface PipelineEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
  FEED_QUEUE: Queue<FeedMessage | SourceQueueMessage>;
  ARTICLE_QUEUE: Queue<ArticleMessage>;
  FEED_INTERVAL_MINUTES: string;
  FEED_FETCH_LEASE_MINUTES: string;
  MAX_CRON_BATCH: string;
  ARTICLE_PARSE_LEASE_MINUTES: string;
  SOURCE_CREDENTIALS_KEY?: string;
  CLASSIFICATION_WORKFLOW: WorkflowBinding<{ articleId: string; sourceHash: string; sourceTextHash?: string; requestId: string; taskId?: string }>;
  BODY_TRANSLATION_WORKFLOW: WorkflowBinding<{ translationId: string; attemptId: string; requestId: string }>;
}

export async function purgeExpiredTranslationErrorLogs(env: PipelineEnv, maximum = 100): Promise<number> {
  const cutoff = new Date(Date.now() - TRANSLATION_DIAGNOSTIC_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const expired = await env.DB.prepare(`SELECT id, provider_response_key AS providerResponseKey
    FROM translation_diagnostics WHERE created_at < ?1 ORDER BY created_at LIMIT ?2`)
    .bind(cutoff, maximum).all<{ id: string; providerResponseKey: string }>();
  const rows = expired.results ?? [];
  if (rows.length > 0) {
    await env.CONTENT.delete(rows.map((row) => row.providerResponseKey));
    const placeholders = rows.map((_, index) => `?${index + 1}`).join(", ");
    await env.DB.prepare(`DELETE FROM translation_diagnostics WHERE id IN (${placeholders})`)
      .bind(...rows.map((row) => row.id)).run();
  }
  await env.DB.prepare(`UPDATE translation_attempts SET error_code = NULL, error_message = NULL
    WHERE created_at < ?1 AND (error_code IS NOT NULL OR error_message IS NOT NULL)`).bind(cutoff).run();
  await env.DB.prepare(`UPDATE translation_batches SET error_code = NULL
    WHERE created_at < ?1 AND error_code IS NOT NULL`).bind(cutoff).run();
  return rows.length;
}

function timestamp(): string {
  return new Date().toISOString();
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function positiveInteger(value: string, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchDirect(
  url: string,
  kind: "feed" | "html",
  conditionalHeaders?: { ifNoneMatch?: string; ifModifiedSince?: string },
): Promise<{
  status: number;
  body: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
}> {
  const fetched = await fetchContent(url, kind, {
    conditionalHeaders,
    maximumBytes: kind === "html" ? ARTICLE_HTML_HARD_LIMIT_BYTES : 8 << 20,
  });
  if (kind !== "html" || new TextEncoder().encode(fetched.body).byteLength <= ARTICLE_HTML_NORMAL_LIMIT_BYTES) {
    return fetched;
  }
  const reducedBody = fetched.body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  if (new TextEncoder().encode(reducedBody).byteLength > ARTICLE_HTML_NORMAL_LIMIT_BYTES) {
    throw new Error("response_too_large_after_reduction");
  }
  return { ...fetched, body: reducedBody };
}

function nextFetchAt(env: PipelineEnv): string {
  const minutes = positiveInteger(env.FEED_INTERVAL_MINUTES, 15, 24 * 60);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function failFeed(env: PipelineEnv, feedId: string, error: unknown): Promise<void> {
  const current = await env.DB.prepare("SELECT failure_count AS failureCount FROM feeds WHERE id = ?1")
    .bind(feedId).first<{ failureCount: number }>();
  const failureCount = Number(current?.failureCount ?? 0) + 1;
  const delaySeconds = Math.min(86_400, 300 * 2 ** Math.min(failureCount - 1, 8));
  const now = timestamp();
  await env.DB.prepare(`UPDATE feeds SET fetch_status = 'failed', failure_count = ?1,
    last_error_code = ?2, next_fetch_at = ?3, updated_at = ?4 WHERE id = ?5`)
    .bind(failureCount, safeError(error), new Date(Date.now() + delaySeconds * 1000).toISOString(), now, feedId).run();
}

async function linkDirectSourceItem(env: PipelineEnv, ownerId: string, connectionId: string, feedId: string, articleId: string, externalItemId: string, canonicalUrl: string, now: string): Promise<void> {
  const scopedExternalItemId = `${feedId}:${externalItemId || canonicalUrl}`;
  await env.DB.prepare(`INSERT INTO source_items
    (id, owner_id, connection_id, source_id, external_item_id, article_id, canonical_url, metadata_json, first_seen_at, last_seen_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '{}', ?8, ?8)
    ON CONFLICT(connection_id, external_item_id) DO UPDATE SET article_id = excluded.article_id,
      source_id = excluded.source_id, canonical_url = excluded.canonical_url, last_seen_at = excluded.last_seen_at`)
    .bind(crypto.randomUUID(), ownerId, connectionId, feedId, scopedExternalItemId, articleId, canonicalUrl, now).run();
}

export async function processFeed(message: FeedMessage, env: PipelineEnv): Promise<void> {
  if (!message?.feedId) throw new Error("Feed message is invalid");
  const feed = await env.DB.prepare(`SELECT owner_id AS ownerId, url, COALESCE(etag, '') AS etag,
    COALESCE(last_modified, '') AS lastModified FROM feeds WHERE id = ?1`)
    .bind(message.feedId).first<{ ownerId: string; url: string; etag: string; lastModified: string }>();
  if (!feed) return;
  const directConnectionId = `connection:direct-rss:${feed.ownerId}`;
  const allowed = await env.DB.prepare(`SELECT 1 AS allowed WHERE
    EXISTS (SELECT 1 FROM account_source_selections WHERE owner_id = ?1 AND active_connection_id = ?2)
    OR EXISTS (SELECT 1 FROM reader_api_credentials WHERE owner_id = ?1 AND revoked_at IS NULL)`)
    .bind(feed.ownerId, directConnectionId).first();
  if (!allowed) return;
  const claim = await env.DB.prepare("UPDATE feeds SET fetch_status = 'running', updated_at = ?1 WHERE id = ?2 AND fetch_status <> 'running'")
    .bind(timestamp(), message.feedId).run();
  if ((claim.meta?.changes ?? 0) === 0) return;
  try {
    const fetched = await fetchDirect(feed.url, "feed", {
      ...(feed.etag ? { ifNoneMatch: feed.etag } : {}),
      ...(feed.lastModified ? { ifModifiedSince: feed.lastModified } : {}),
    });
    if (fetched.status === 304) {
      const now = timestamp();
      await env.DB.prepare(`UPDATE feeds SET fetch_status = 'succeeded', failure_count = 0,
        last_error_code = NULL, last_fetched_at = ?1, next_fetch_at = ?2, updated_at = ?1 WHERE id = ?3`)
        .bind(now, nextFetchAt(env), message.feedId).run();
      return;
    }
    const parsed = parseFeed(fetched.body, fetched.contentType, fetched.finalUrl);
    if (!parsed.title && parsed.siteUrl) {
      try {
        const site = await fetchDirect(parsed.siteUrl, "html");
        parsed.title = articleTitle(site.body);
      } catch {
        // The feed URL hostname fallback below remains deterministic.
      }
    }
    if (!parsed.title) {
      try { parsed.title = new URL(parsed.siteUrl || fetched.finalUrl).hostname.replace(/^www\./, ""); } catch { /* Keep the stored title. */ }
    }
    const now = timestamp();
    await env.DB.prepare(`INSERT INTO source_connections
      (id, owner_id, connector_type, name, sync_policy, capabilities_json, cursor_json, status, created_at, updated_at)
      VALUES (?1, ?2, 'direct_rss', 'Direct RSS', 'feedmind_primary',
        '{"categories":true,"incrementalCursor":true,"readState":false,"writeState":false}', '{}', 'ok', ?3, ?3)
      ON CONFLICT(id) DO NOTHING`).bind(directConnectionId, feed.ownerId, now).run();
    await env.DB.prepare(`UPDATE feeds SET title = COALESCE(NULLIF(?1, ''), title),
      site_url = NULLIF(?2, ''), description = NULLIF(?3, ''), etag = ?4, last_modified = ?5,
      fetch_status = 'succeeded', failure_count = 0, last_error_code = NULL,
      last_fetched_at = ?6, next_fetch_at = ?7, updated_at = ?6 WHERE id = ?8`)
      .bind(parsed.title, parsed.siteUrl, parsed.description, fetched.etag, fetched.lastModified,
        now, nextFetchAt(env), message.feedId).run();
    await env.DB.prepare(`INSERT INTO sources
      (id, owner_id, connection_id, external_id, kind, title, url, site_url, enabled, sync_status,
       last_synced_at, legacy_feed_id, metadata_json, custom_title, library_category_id, library_sort_order, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'feed', ?5, ?4, ?6, 1, 'ok', ?7, ?1, '{}',
        (SELECT NULLIF(custom_title, '') FROM subscriptions WHERE owner_id = ?2 AND feed_id = ?1 LIMIT 1),
        (SELECT category.id FROM subscriptions sub JOIN library_categories category
          ON category.owner_id = sub.owner_id AND category.name = sub.category COLLATE NOCASE
          WHERE sub.owner_id = ?2 AND sub.feed_id = ?1 LIMIT 1),
        COALESCE((SELECT sort_order FROM subscriptions WHERE owner_id = ?2 AND feed_id = ?1 LIMIT 1), 0), ?7, ?7)
      ON CONFLICT(connection_id, external_id) DO UPDATE SET title = excluded.title, site_url = excluded.site_url,
        sync_status = 'ok', last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at`)
      .bind(message.feedId, feed.ownerId, directConnectionId, feed.url, parsed.title, parsed.siteUrl, now).run();

    for (const item of parsed.items) {
      const existing = await env.DB.prepare(`SELECT id, parse_status AS parseStatus FROM articles
        WHERE owner_id = ?1 AND ((feed_id = ?2 AND NULLIF(?3, '') IS NOT NULL AND external_id = ?3) OR canonical_url = ?4)
        ORDER BY CASE WHEN feed_id = ?2 THEN 0 ELSE 1 END LIMIT 1`)
        .bind(feed.ownerId, message.feedId, item.externalId, item.url).first<{ id: string; parseStatus: string }>();
      if (existing) {
        await env.DB.prepare(`UPDATE articles SET title = ?1, author = NULLIF(?2, ''), summary = NULLIF(?3, ''),
          external_id = NULLIF(?4, ''), published_at = COALESCE(?5, published_at), updated_at = ?6 WHERE id = ?7`)
          .bind(item.title, item.author, item.summary, item.externalId, item.publishedAt, now, existing.id).run();
        await linkDirectSourceItem(env, feed.ownerId, directConnectionId, message.feedId, existing.id, item.externalId, item.url, now);
        if (existing.parseStatus === "pending") {
          await env.DB.prepare(`INSERT OR IGNORE INTO article_parse_tasks
            (id, article_id, source_url, status, requested_by, request_id, created_at)
            VALUES (?1, ?2, ?3, 'pending', 'system', ?4, ?5)`)
            .bind(crypto.randomUUID(), existing.id, item.url, message.requestId || crypto.randomUUID(), now).run();
          await env.ARTICLE_QUEUE.send({ articleId: existing.id, requestId: message.requestId, reason: "feed_discovered" }, { contentType: "json" });
        }
        continue;
      }
      const articleId = crypto.randomUUID();
      const parseTaskId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO articles
          (id, owner_id, feed_id, canonical_url, external_id, title, author, summary, published_at, parse_status, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, NULLIF(?5, ''), ?6, NULLIF(?7, ''), NULLIF(?8, ''), ?9, 'pending', ?10, ?10)`)
          .bind(articleId, feed.ownerId, message.feedId, item.url, item.externalId, item.title, item.author, item.summary, item.publishedAt, now),
        env.DB.prepare(`INSERT INTO article_parse_tasks
          (id, article_id, source_url, status, requested_by, request_id, created_at)
          VALUES (?1, ?2, ?3, 'pending', 'system', ?4, ?5)`)
          .bind(parseTaskId, articleId, item.url, message.requestId || crypto.randomUUID(), now),
      ]);
      await linkDirectSourceItem(env, feed.ownerId, directConnectionId, message.feedId, articleId, item.externalId, item.url, now);
      await env.ARTICLE_QUEUE.send({ articleId, requestId: message.requestId, reason: "feed_discovered" } as ArticleMessage, { contentType: "json" });
    }
  } catch (error) {
    await failFeed(env, message.feedId, error);
    throw error;
  }
}

function articleTitle(html: string): string {
  try { return (parseHTML(html).document.querySelector("title")?.textContent ?? "").trim(); } catch { return ""; }
}

function thumbnail(html: string): string {
  try { return parseHTML(`<body>${html}</body>`).document.querySelector("img")?.getAttribute("src")?.trim() ?? ""; } catch { return ""; }
}

async function failArticle(env: PipelineEnv, articleId: string, error: unknown): Promise<void> {
  const now = timestamp();
  const errorMessage = safeError(error);
  await env.DB.batch([
    env.DB.prepare("UPDATE articles SET parse_status = 'failed', parse_error = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(errorMessage, now, articleId),
    env.DB.prepare(`UPDATE article_parse_tasks SET status = 'failed', attempt_count = attempt_count + 1,
      error_code = 'article_parse_failed', error_message = ?1, completed_at = ?2
      WHERE article_id = ?3 AND status = 'running'`).bind(errorMessage, now, articleId),
  ]);
}

function startArticleParseHeartbeat(env: PipelineEnv, articleId: string): () => Promise<void> {
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      await env.DB.prepare(`UPDATE article_parse_tasks SET heartbeat_at = ?1
        WHERE article_id = ?2 AND status = 'running'`).bind(timestamp(), articleId).run();
    }).catch((error) => {
      console.error({
        service: "feedmind-pipeline",
        event: "article_parse_heartbeat_failed",
        articleId,
        error: safeError(error),
      });
    });
  }, ARTICLE_PARSE_HEARTBEAT_INTERVAL_MS);
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

export async function processArticle(message: ArticleMessage, env: PipelineEnv): Promise<void> {
  if (!message?.articleId) throw new Error("Article message is invalid");
  const article = await env.DB.prepare("SELECT canonical_url AS url, title, feed_id AS feedId FROM articles WHERE id = ?1")
    .bind(message.articleId).first<{ url: string; title: string; feedId: string | null }>();
  if (!article) return;
  const claimedAt = timestamp();
  const claimed = await env.DB.prepare(`UPDATE article_parse_tasks SET status = 'running', started_at = ?1,
    heartbeat_at = ?1, completed_at = NULL, error_code = NULL, error_message = NULL
    WHERE id = (SELECT id FROM article_parse_tasks WHERE article_id = ?2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1)`)
    .bind(claimedAt, message.articleId).run();
  if ((claimed.meta?.changes ?? 0) === 0) return;
  const stopHeartbeat = startArticleParseHeartbeat(env, message.articleId);
  try {
    await env.DB.prepare("UPDATE articles SET parse_status = 'running', parse_error = NULL, updated_at = ?1 WHERE id = ?2")
      .bind(timestamp(), message.articleId).run();
    let fetched: Awaited<ReturnType<typeof fetchDirect>>;
    try {
      fetched = await fetchDirect(article.url, "html");
    } catch (fetchError) {
      const fallback = await env.DB.prepare(`SELECT si.upstream_content_key AS contentKey,
        COALESCE(si.canonical_url, a.canonical_url) AS finalUrl
        FROM source_items si JOIN articles a ON a.id = si.article_id
        WHERE si.article_id = ?1 AND si.upstream_content_key IS NOT NULL
        ORDER BY si.last_seen_at DESC LIMIT 1`).bind(message.articleId).first<{ contentKey: string; finalUrl: string }>();
      const object = fallback ? await env.CONTENT.get(fallback.contentKey) : null;
      if (!fallback || !object) throw fetchError;
      fetched = { status: 200, body: await object.text(), contentType: "text/html; charset=utf-8",
        etag: null, lastModified: null, finalUrl: fallback.finalUrl };
    }
    let extractionRuleVersionId: string | null = null;
    let extractionRule: FeedExtractionRuleConfig | null = null;
    if (article.feedId) {
      const activeRule = await env.DB.prepare(`SELECT v.id, v.rule_json AS ruleJson
        FROM feed_extraction_rules r JOIN feed_extraction_rule_versions v ON v.id = r.active_version_id
        WHERE r.feed_id = ?1 AND v.status = 'active'`).bind(article.feedId)
        .first<{ id: string; ruleJson: string }>();
      if (activeRule) {
        extractionRuleVersionId = activeRule.id;
        try { extractionRule = validateFeedExtractionRule(JSON.parse(activeRule.ruleJson)); }
        catch { extractionRule = {} as FeedExtractionRuleConfig; }
      }
    }
    const extracted = extractArticleWithRule(fetched.body, fetched.finalUrl, extractionRule);
    const html = extracted.html;
    const plainText = contentHtmlToText(html);
    if (!html.trim() || !plainText.trim()) throw new Error("Readable article content is empty");
    const hash = await sha256(html);
    const baseKey = `articles/${message.articleId}/${hash}`;
    const htmlKey = `${baseKey}/source.html`;
    const textKey = `${baseKey}/source.txt`;
    const encoder = new TextEncoder();
    const htmlBytes = encoder.encode(html);
    const textBytes = encoder.encode(plainText);
    await Promise.all([
      env.CONTENT.put(htmlKey, htmlBytes, { httpMetadata: { contentType: "text/html; charset=utf-8" }, customMetadata: { sha256: hash } }),
      env.CONTENT.put(textKey, textBytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" }, customMetadata: { sourceHash: hash } }),
    ]);
    if (article.feedId) await persistArticleContentBlocks(env, {
      articleId: message.articleId, feedId: article.feedId, sourceHash: hash, html,
    });
    const now = timestamp();
    const extractedTitle = articleTitle(fetched.body);
    const sourceTextHash = await sha256(plainText);
    const preprocessingTaskId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`UPDATE articles SET
        title = CASE WHEN title = canonical_url AND ?1 <> '' THEN ?1 ELSE title END,
        canonical_url = CASE WHEN EXISTS (SELECT 1 FROM articles existing
          WHERE existing.owner_id = articles.owner_id AND existing.canonical_url = ?2
            AND existing.id <> articles.id) THEN canonical_url ELSE ?2 END,
        source_hash = ?3,
        source_html_key = ?4, source_html_hash = ?3, source_html_bytes = ?5,
        source_text_key = ?6, source_text_hash = ?7, source_text_bytes = ?8,
        source_mime_type = 'text/html; charset=utf-8', thumbnail_url = NULLIF(?9, ''),
        parse_status = 'completed', parser_version = 12, parse_error = NULL,
        extraction_rule_version_id = ?10, extraction_strategy = ?11, extraction_diagnostic_code = ?12,
        parsed_at = ?13, updated_at = ?13
        WHERE id = ?14 AND EXISTS (SELECT 1 FROM article_parse_tasks t
          WHERE t.article_id = articles.id AND t.status = 'running')`).bind(extractedTitle, fetched.finalUrl, hash, htmlKey, htmlBytes.byteLength,
        textKey, sourceTextHash, textBytes.byteLength, thumbnail(html), extractionRuleVersionId,
        extracted.strategy, extracted.diagnostics.code, now, message.articleId),
      env.DB.prepare(`UPDATE article_parse_tasks SET status = 'completed', attempt_count = attempt_count + 1,
        error_code = NULL, error_message = NULL, completed_at = ?1
        WHERE article_id = ?2 AND status = 'running'`).bind(now, message.articleId),
      env.DB.prepare(`INSERT INTO article_preprocessing_tasks
        (id, article_id, source_hash, source_text_hash, status, requested_by, request_id, created_at)
        VALUES (?1, ?2, ?3, ?4, 'pending', 'system', ?5, ?6)`)
        .bind(preprocessingTaskId, message.articleId, hash, sourceTextHash, message.requestId || crypto.randomUUID(), now),
    ]);
    console.log({ service: "feedmind-pipeline", event: "article_extraction_completed", articleId: message.articleId,
      feedId: article.feedId, ruleVersionId: extractionRuleVersionId, strategy: extracted.strategy,
      diagnosticCode: extracted.diagnostics.code, removedNodes: extracted.diagnostics.removedNodes });
    try {
      await env.CLASSIFICATION_WORKFLOW.create({
        id: classificationWorkflowId(message.articleId, sourceTextHash),
        params: { articleId: message.articleId, sourceHash: hash, sourceTextHash, requestId: message.requestId, taskId: preprocessingTaskId },
      });
    } catch (error) {
      console.error({
        service: "feedmind-pipeline",
        event: "classification_workflow_create_failed",
        articleId: message.articleId,
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown error",
      });
    }
  } catch (error) {
    await failArticle(env, message.articleId, error);
    throw error;
  } finally {
    await stopHeartbeat();
  }
}

export async function scheduleDueWork(env: PipelineEnv): Promise<{ feeds: number; sourceConnections: number; articles: number; contentBlockBackfills: number; classifications: number; translations: number }> {
  const maximum = positiveInteger(env.MAX_CRON_BATCH, 100, 500);
  try {
    await purgeExpiredTranslationErrorLogs(env, maximum);
  } catch (error) {
    console.error({
      service: "feedmind-pipeline",
      event: "translation_error_log_cleanup_failed",
      error: safeError(error),
    });
  }
  const now = timestamp();
  const feedFetchLeaseMinutes = positiveInteger(env.FEED_FETCH_LEASE_MINUTES, 5, 60);
  const feedFetchLeaseCutoff = new Date(Date.now() - feedFetchLeaseMinutes * 60_000).toISOString();
  const articleParseLeaseMinutes = positiveInteger(env.ARTICLE_PARSE_LEASE_MINUTES, 5, 60);
  const articleParseLeaseCutoff = new Date(Date.now() - articleParseLeaseMinutes * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE feeds SET fetch_status = 'failed', failure_count = failure_count + 1,
      last_error_code = 'feed_fetch_lease_expired', next_fetch_at = ?1, updated_at = ?1
      WHERE fetch_status = 'running' AND updated_at <= ?2`).bind(now, feedFetchLeaseCutoff),
    env.DB.prepare(`UPDATE article_parse_tasks SET status = 'failed', completed_at = ?1,
      attempt_count = attempt_count + 1, error_code = 'article_parse_lease_expired',
      error_message = 'Article parse worker repeatedly stopped before completing'
      WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) <= ?2
        AND attempt_count >= ?3`).bind(now, articleParseLeaseCutoff, MAX_ARTICLE_PARSE_LEASE_RECOVERIES),
    env.DB.prepare(`UPDATE article_parse_tasks SET status = 'pending', started_at = NULL,
      heartbeat_at = NULL, completed_at = NULL, attempt_count = attempt_count + 1,
      error_code = 'article_parse_lease_expired',
      error_message = 'Article parse worker stopped before completing; task was queued again'
      WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) <= ?2
        AND attempt_count < ?3`).bind(now, articleParseLeaseCutoff, MAX_ARTICLE_PARSE_LEASE_RECOVERIES),
    env.DB.prepare(`UPDATE articles SET parse_status = 'pending',
      parse_error = NULL, updated_at = ?1
      WHERE parse_status = 'running' AND EXISTS (
        SELECT 1 FROM article_parse_tasks t WHERE t.article_id = articles.id AND t.status = 'pending'
      )`).bind(now),
    env.DB.prepare(`UPDATE articles SET parse_status = 'failed',
      parse_error = 'Article parse worker stopped before completing', updated_at = ?1
      WHERE parse_status = 'running' AND NOT EXISTS (
        SELECT 1 FROM article_parse_tasks t WHERE t.article_id = articles.id
          AND t.status IN ('pending', 'running')
      )`).bind(now),
  ]);
  const feeds = await env.DB.prepare(`SELECT f.id FROM feeds f
    WHERE f.next_fetch_at IS NOT NULL AND f.next_fetch_at <= ?1 AND f.fetch_status <> 'running'
      AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = f.id AND s.owner_id = f.owner_id AND s.is_active = 1)
      AND (EXISTS (SELECT 1 FROM account_source_selections selection
        WHERE selection.owner_id = f.owner_id AND selection.active_connection_id = 'connection:direct-rss:' || f.owner_id)
        OR EXISTS (SELECT 1 FROM reader_api_credentials credential
          WHERE credential.owner_id = f.owner_id AND credential.revoked_at IS NULL))
    ORDER BY f.next_fetch_at LIMIT ?2`).bind(now, maximum).all<{ id: string }>();
  for (const feed of feeds.results ?? []) {
    await env.FEED_QUEUE.send({ feedId: feed.id, requestId: crypto.randomUUID(), reason: "scheduled" } as FeedMessage, { contentType: "json" });
  }
  const sourceConnections = await env.DB.prepare(`SELECT connection.id, selection.revision FROM source_connections connection
    JOIN account_source_selections selection ON selection.active_connection_id = connection.id
      AND selection.owner_id = connection.owner_id
    WHERE connection.connector_type <> 'direct_rss' AND connection.next_sync_at IS NOT NULL AND connection.next_sync_at <= ?1
      AND connection.status NOT IN ('syncing', 'disabled') ORDER BY connection.next_sync_at LIMIT ?2`)
    .bind(now, maximum).all<{ id: string; revision: number }>();
  for (const connection of sourceConnections.results ?? []) {
    await env.FEED_QUEUE.send({ connectionId: connection.id, selectionRevision: connection.revision,
      requestId: crypto.randomUUID(), reason: "scheduled" }, { contentType: "json" });
  }
  const tasks = await env.DB.prepare(`SELECT article_id AS articleId, request_id AS requestId FROM article_parse_tasks
    WHERE status = 'pending' ORDER BY created_at LIMIT ?1`).bind(maximum).all<{ articleId: string; requestId: string }>();
  for (const task of tasks.results ?? []) {
    await env.ARTICLE_QUEUE.send({ articleId: task.articleId, requestId: task.requestId, reason: "pending_recovery" } as ArticleMessage, { contentType: "json" });
  }
  const contentBlockBackfills = await env.DB.prepare(`SELECT a.id FROM articles a
    WHERE a.parse_status = 'completed' AND a.feed_id IS NOT NULL AND a.source_hash IS NOT NULL AND a.source_html_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM article_content_blocks b WHERE b.article_id = a.id AND b.source_hash = a.source_hash
        AND b.policy_version = ?1)
    ORDER BY COALESCE(a.published_at, a.created_at), a.id LIMIT ?2`)
    .bind(CONTENT_BLOCK_INDEX_VERSION, maximum).all<{ id: string }>();
  for (const article of contentBlockBackfills.results ?? []) {
    await env.ARTICLE_QUEUE.send({ articleId: article.id, requestId: crypto.randomUUID(), reason: "content_block_backfill" }, { contentType: "json" });
  }
  const classifications = await env.DB.prepare(`SELECT t.id AS taskId, a.id, a.source_hash AS sourceHash,
    a.source_text_hash AS sourceTextHash, t.request_id AS requestId
    FROM article_preprocessing_tasks t JOIN articles a ON a.id = t.article_id
    WHERE t.status = 'pending' AND a.parse_status = 'completed' AND a.source_hash = t.source_hash
      AND a.source_text_hash = t.source_text_hash
    ORDER BY t.created_at LIMIT ?1`).bind(maximum).all<{
      taskId: string; id: string; sourceHash: string; sourceTextHash: string; requestId: string;
    }>();
  for (const article of classifications.results ?? []) {
    try {
      await env.CLASSIFICATION_WORKFLOW.create({
        id: classificationWorkflowId(article.id, article.sourceTextHash),
        params: { articleId: article.id, sourceHash: article.sourceHash, sourceTextHash: article.sourceTextHash,
          requestId: article.requestId, taskId: article.taskId },
      });
    } catch {
      // An existing retained workflow instance is already responsible for this version.
    }
  }
  const translations = await env.DB.prepare(`SELECT t.id AS translationId, x.id AS attemptId,
    x.attempt, t.request_id AS requestId FROM translations t
    JOIN translation_attempts x ON x.translation_id = t.id
    WHERE t.status = 'pending' AND x.status = 'pending'
      AND x.attempt = (SELECT MAX(y.attempt) FROM translation_attempts y WHERE y.translation_id = t.id)
    ORDER BY t.created_at LIMIT ?1`).bind(maximum).all<{
      translationId: string; attemptId: string; attempt: number; requestId: string;
    }>();
  for (const translation of translations.results ?? []) {
    try {
      const instance = await env.BODY_TRANSLATION_WORKFLOW.create({
        id: `translation-${translation.translationId}-attempt-${translation.attempt}`,
        params: { translationId: translation.translationId, attemptId: translation.attemptId, requestId: translation.requestId },
      });
      await env.DB.batch([
        env.DB.prepare("UPDATE translations SET workflow_instance_id = ?1 WHERE id = ?2")
          .bind(instance.id, translation.translationId),
        env.DB.prepare("UPDATE translation_attempts SET workflow_instance_id = ?1 WHERE id = ?2")
          .bind(instance.id, translation.attemptId),
      ]);
    } catch {
      // An existing retained workflow instance is already responsible for this attempt.
    }
  }
  return {
    feeds: feeds.results?.length ?? 0,
    sourceConnections: sourceConnections.results?.length ?? 0,
    articles: tasks.results?.length ?? 0,
    contentBlockBackfills: contentBlockBackfills.results?.length ?? 0,
    classifications: classifications.results?.length ?? 0,
    translations: translations.results?.length ?? 0,
  };
}
