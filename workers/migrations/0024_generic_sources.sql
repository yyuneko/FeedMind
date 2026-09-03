PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  normalized_email TEXT,
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (normalized_email IS NULL OR normalized_email = lower(trim(normalized_email)))
);

CREATE UNIQUE INDEX accounts_verified_email_idx ON accounts(normalized_email)
  WHERE normalized_email IS NOT NULL AND email_verified_at IS NOT NULL;

CREATE TABLE account_identities (
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email_at_link TEXT NOT NULL,
  last_seen_email TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_subject),
  UNIQUE (provider, account_id)
);

CREATE TABLE source_connections (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL CHECK (connector_type IN ('direct_rss', 'google_reader')),
  name TEXT NOT NULL,
  base_url TEXT,
  credentials_encrypted TEXT,
  sync_policy TEXT NOT NULL CHECK (sync_policy IN ('feedmind_primary', 'upstream_primary', 'bidirectional')),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  cursor_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'syncing', 'ok', 'error', 'disabled')),
  last_error_code TEXT,
  last_synced_at TEXT,
  next_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (json_valid(capabilities_json)),
  CHECK (json_valid(cursor_json)),
  UNIQUE (owner_id, connector_type, base_url)
);

CREATE INDEX source_connections_due_idx ON source_connections(next_sync_at)
  WHERE status <> 'syncing' AND status <> 'disabled';

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'feed',
  title TEXT NOT NULL DEFAULT '',
  url TEXT,
  site_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'ok', 'error', 'disabled')),
  last_error_code TEXT,
  last_synced_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  legacy_feed_id TEXT UNIQUE REFERENCES feeds(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (json_valid(metadata_json)),
  UNIQUE (connection_id, external_id)
);

CREATE INDEX sources_owner_idx ON sources(owner_id, enabled, lower(title));

CREATE TABLE source_categories (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, name)
);

CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_item_id TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  canonical_url TEXT,
  upstream_content_key TEXT,
  upstream_is_read INTEGER CHECK (upstream_is_read IS NULL OR upstream_is_read IN (0, 1)),
  upstream_is_saved INTEGER CHECK (upstream_is_saved IS NULL OR upstream_is_saved IN (0, 1)),
  upstream_updated_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  CHECK (json_valid(metadata_json)),
  UNIQUE (connection_id, external_item_id)
);

CREATE INDEX source_items_article_idx ON source_items(article_id, source_id);
CREATE INDEX source_items_source_idx ON source_items(source_id, last_seen_at DESC);

CREATE TABLE state_sync_outbox (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  desired_read INTEGER CHECK (desired_read IS NULL OR desired_read IN (0, 1)),
  desired_saved INTEGER CHECK (desired_saved IS NULL OR desired_saved IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX state_sync_outbox_due_idx ON state_sync_outbox(connection_id, next_attempt_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE gpt_api_clients (
  key_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'GPT Actions',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- Preserve every account identifier present in the D1 dataset. Before cutover,
-- import each verified legacy user's email into the matching account row. The
-- first Access login then links that account by verified email exactly once.
INSERT OR IGNORE INTO accounts (id, email, normalized_email, email_verified_at, created_at, updated_at)
SELECT DISTINCT owner_id, '', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM feeds;
INSERT OR IGNORE INTO accounts (id, email, normalized_email, email_verified_at, created_at, updated_at)
SELECT DISTINCT owner_id, '', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM subscriptions;
INSERT OR IGNORE INTO accounts (id, email, normalized_email, email_verified_at, created_at, updated_at)
SELECT DISTINCT owner_id, '', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM articles;
INSERT OR IGNORE INTO accounts (id, email, normalized_email, email_verified_at, created_at, updated_at)
SELECT DISTINCT owner_id, '', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM article_states;
INSERT OR IGNORE INTO accounts (id, email, normalized_email, email_verified_at, created_at, updated_at)
SELECT DISTINCT owner_id, '', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM prompts;
INSERT OR IGNORE INTO accounts (id, email, normalized_email, email_verified_at, created_at, updated_at)
SELECT DISTINCT owner_id, '', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM preferences;
INSERT OR IGNORE INTO accounts (id, email, normalized_email, email_verified_at, created_at, updated_at)
SELECT DISTINCT owner_id, '', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM thinking_sessions;
INSERT OR IGNORE INTO accounts (id, email, normalized_email, email_verified_at, created_at, updated_at)
SELECT DISTINCT owner_id, '', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM translations;

INSERT INTO source_connections
  (id, owner_id, connector_type, name, sync_policy, capabilities_json, cursor_json,
   status, last_synced_at, next_sync_at, created_at, updated_at)
SELECT
  'connection:direct-rss:' || id, id, 'direct_rss', 'Direct RSS', 'feedmind_primary',
   '{"categories":true,"incrementalCursor":true,"readState":false,"writeState":false}', '{}',
   'ok', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM accounts;

INSERT INTO sources
  (id, owner_id, connection_id, external_id, kind, title, url, site_url, enabled,
   sync_status, last_error_code, last_synced_at, legacy_feed_id, created_at, updated_at)
SELECT f.id, f.owner_id, 'connection:direct-rss:' || f.owner_id, f.url, 'feed', f.title, f.url, f.site_url,
       COALESCE(s.is_active, 1),
       CASE f.fetch_status WHEN 'succeeded' THEN 'ok' WHEN 'running' THEN 'syncing'
         WHEN 'failed' THEN 'error' ELSE 'pending' END,
       f.last_error_code, f.last_fetched_at, f.id, f.created_at, f.updated_at
FROM feeds f LEFT JOIN subscriptions s ON s.feed_id = f.id AND s.owner_id = f.owner_id;

INSERT OR IGNORE INTO source_categories(source_id, name, sort_order)
SELECT feed_id, category, 0 FROM subscriptions WHERE NULLIF(trim(category), '') IS NOT NULL;

INSERT INTO source_items
  (id, owner_id, connection_id, source_id, external_item_id, article_id, canonical_url,
   metadata_json, first_seen_at, last_seen_at)
SELECT 'legacy:' || a.id, a.owner_id, 'connection:direct-rss:' || a.owner_id, a.feed_id,
       a.feed_id || ':' || COALESCE(NULLIF(a.external_id, ''), a.canonical_url), a.id, a.canonical_url, '{}',
       a.created_at, a.updated_at
FROM articles a WHERE a.feed_id IS NOT NULL;
