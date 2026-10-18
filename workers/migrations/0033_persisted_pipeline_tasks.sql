PRAGMA foreign_keys = ON;

-- Content-block backfills are explicit durable work items. A policy-version
-- migration seeds them once; the recurring scheduler must not rediscover work
-- by scanning the complete articles table.
CREATE TABLE article_content_block_backfill_tasks (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  request_id TEXT NOT NULL,
  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(article_id, source_hash, policy_version)
);

CREATE INDEX article_content_block_backfill_pending_idx
  ON article_content_block_backfill_tasks(created_at, id)
  WHERE status = 'pending';

CREATE INDEX article_content_block_backfill_queued_idx
  ON article_content_block_backfill_tasks(queued_at, id)
  WHERE status = 'queued';

-- One-time bootstrap for the current content-block policy. Future policy
-- versions should enqueue their own migration tasks in the same way.
INSERT OR IGNORE INTO article_content_block_backfill_tasks
  (id, article_id, source_hash, policy_version, status, attempt_count, request_id, created_at, updated_at)
SELECT lower(hex(randomblob(16))), article.id, article.source_hash, 'content-block-index-v1',
  'pending', 0, 'migration-0033:' || article.id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM articles article
WHERE article.parse_status = 'completed'
  AND article.feed_id IS NOT NULL
  AND article.source_hash IS NOT NULL
  AND article.source_html_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM article_content_blocks block
    WHERE block.article_id = article.id
      AND block.source_hash = article.source_hash
      AND block.policy_version = 'content-block-index-v1'
  );

-- Lease recovery and daily retention work should touch only matching rows.
CREATE INDEX article_parse_tasks_running_heartbeat_idx
  ON article_parse_tasks(heartbeat_at, id)
  WHERE status = 'running';

CREATE INDEX article_parse_tasks_pending_created_idx
  ON article_parse_tasks(created_at, id)
  WHERE status = 'pending';

CREATE INDEX translations_pending_created_idx
  ON translations(created_at, id)
  WHERE status = 'pending';

CREATE INDEX translation_attempts_pending_lookup_idx
  ON translation_attempts(translation_id, attempt DESC)
  WHERE status = 'pending';

CREATE INDEX feeds_running_updated_idx
  ON feeds(updated_at, id)
  WHERE fetch_status = 'running';

-- RSS feeds repeatedly present the same items. Resolve an existing article by
-- its feed-scoped external ID with a point lookup instead of scanning every
-- article owned by the account through an OR expression.
CREATE INDEX articles_owner_feed_external_idx
  ON articles(owner_id, feed_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX translation_diagnostics_created_idx
  ON translation_diagnostics(created_at, id);

CREATE INDEX translation_attempts_error_created_idx
  ON translation_attempts(created_at, id)
  WHERE error_code IS NOT NULL OR error_message IS NOT NULL;

CREATE INDEX translation_batches_error_created_idx
  ON translation_batches(created_at, id)
  WHERE error_code IS NOT NULL;
