PRAGMA foreign_keys = ON;

CREATE TABLE account_source_selections (
  owner_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  active_connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL
);

INSERT INTO account_source_selections(owner_id, active_connection_id, revision, updated_at)
SELECT a.id, 'connection:direct-rss:' || a.id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM accounts a
WHERE EXISTS (SELECT 1 FROM source_connections c
  WHERE c.id = 'connection:direct-rss:' || a.id AND c.owner_id = a.id);

CREATE INDEX account_source_selections_connection_idx
  ON account_source_selections(active_connection_id);

ALTER TABLE article_states RENAME TO article_states_legacy_0027;

CREATE TABLE article_states (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  is_saved INTEGER NOT NULL DEFAULT 0 CHECK (is_saved IN (0,1)),
  reading_progress REAL NOT NULL DEFAULT 0 CHECK (reading_progress >= 0 AND reading_progress <= 1),
  read_at TEXT,
  saved_at TEXT,
  last_opened_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, connection_id, article_id)
);

INSERT INTO article_states
  (owner_id, connection_id, article_id, is_read, is_saved, reading_progress,
   read_at, saved_at, last_opened_at, updated_at)
SELECT owner_id, 'connection:direct-rss:' || owner_id, article_id, is_read, is_saved,
       reading_progress, read_at, saved_at, last_opened_at, updated_at
FROM article_states_legacy_0027
WHERE EXISTS (SELECT 1 FROM source_connections c
  WHERE c.id = 'connection:direct-rss:' || article_states_legacy_0027.owner_id);

INSERT INTO article_states
  (owner_id, connection_id, article_id, is_read, is_saved, reading_progress, updated_at)
SELECT owner_id, connection_id, article_id,
       MAX(COALESCE(upstream_is_read, 0)), MAX(COALESCE(upstream_is_saved, 0)), 0,
       MAX(COALESCE(upstream_updated_at, last_seen_at))
FROM source_items
WHERE connection_id NOT LIKE 'connection:direct-rss:%'
GROUP BY owner_id, connection_id, article_id
ON CONFLICT(owner_id, connection_id, article_id) DO NOTHING;

DROP TABLE article_states_legacy_0027;

CREATE INDEX article_states_recent_idx
  ON article_states(owner_id, connection_id, last_opened_at DESC)
  WHERE last_opened_at IS NOT NULL;

ALTER TABLE article_state_operations ADD COLUMN connection_id TEXT REFERENCES source_connections(id) ON DELETE CASCADE;
CREATE INDEX article_state_operations_connection_idx
  ON article_state_operations(owner_id, connection_id, operation_id);

CREATE TABLE source_switch_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  to_connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  selection_revision INTEGER NOT NULL,
  migrate_to_target INTEGER NOT NULL CHECK (migrate_to_target IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','partial','failed','superseded')),
  total_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX source_switch_jobs_owner_idx
  ON source_switch_jobs(owner_id, created_at DESC);

CREATE TABLE source_switch_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES source_switch_jobs(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('subscription','article_state')),
  source_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, item_type, source_key)
);

CREATE INDEX source_switch_job_items_due_idx
  ON source_switch_job_items(job_id, status, item_type);

CREATE TABLE reader_api_credentials (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  login_name TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX reader_api_credentials_owner_idx
  ON reader_api_credentials(owner_id, revoked_at, created_at DESC);
CREATE INDEX reader_api_credentials_login_idx
  ON reader_api_credentials(login_name, revoked_at);

CREATE TABLE reader_api_sessions (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES reader_api_credentials(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX reader_api_sessions_token_idx
  ON reader_api_sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE reader_api_item_ids (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL UNIQUE
);

CREATE TABLE reader_api_rate_limits (
  bucket_key TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY(bucket_key, window_started_at)
);
