PRAGMA foreign_keys = ON;

CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  site_url TEXT,
  description TEXT,
  etag TEXT,
  last_modified TEXT,
  fetch_status TEXT NOT NULL DEFAULT 'pending' CHECK (fetch_status IN ('pending', 'running', 'succeeded', 'failed')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error_code TEXT,
  last_fetched_at TEXT,
  next_fetch_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, url)
);

CREATE INDEX feeds_due_idx ON feeds (next_fetch_at) WHERE fetch_status <> 'running';

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  category TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, feed_id)
);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  feed_id TEXT REFERENCES feeds(id) ON DELETE SET NULL,
  canonical_url TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  author TEXT,
  summary TEXT,
  published_at TEXT,
  source_hash TEXT,
  source_html_key TEXT,
  source_html_hash TEXT,
  source_html_bytes INTEGER CHECK (source_html_bytes IS NULL OR source_html_bytes >= 0),
  source_text_key TEXT,
  source_text_hash TEXT,
  source_text_bytes INTEGER CHECK (source_text_bytes IS NULL OR source_text_bytes >= 0),
  source_mime_type TEXT,
  parse_status TEXT NOT NULL DEFAULT 'pending' CHECK (parse_status IN ('pending', 'running', 'completed', 'failed')),
  parsed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, canonical_url)
);

CREATE INDEX articles_feed_published_idx ON articles (feed_id, published_at DESC);
CREATE INDEX articles_owner_published_idx ON articles (owner_id, published_at DESC);

CREATE TABLE article_states (
  owner_id TEXT NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  is_saved INTEGER NOT NULL DEFAULT 0 CHECK (is_saved IN (0, 1)),
  reading_progress REAL NOT NULL DEFAULT 0 CHECK (reading_progress >= 0 AND reading_progress <= 1),
  read_at TEXT,
  saved_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, article_id)
);

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE preferences (
  owner_id TEXT PRIMARY KEY DEFAULT 'owner' CHECK (owner_id = 'owner'),
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  target_locale TEXT NOT NULL DEFAULT 'zh-CN',
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  CHECK (json_valid(settings_json))
);

CREATE TABLE thinking_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  article_id TEXT REFERENCES articles(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
  summary TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE thinking_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES thinking_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (json_valid(payload_json)),
  UNIQUE (session_id, sequence)
);

CREATE TABLE article_types (
  key TEXT PRIMARY KEY CHECK (key IN ('technical', 'news', 'general')),
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO article_types (key, display_name, description, updated_at) VALUES
  ('technical', '技术', '技术文章、开发文档、论文解读和工程实践', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('news', '新闻', '新闻、事件报道、行业动态和公告', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('general', '通用', '无法可靠归入其他类型的内容', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE prompt_definitions (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL CHECK (task IN ('classification', 'title_translation', 'body_translation', 'body_repair')),
  article_type TEXT REFERENCES article_types(key),
  target_locale TEXT NOT NULL,
  current_version_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (task IN ('classification', 'title_translation') AND article_type IS NULL) OR
    (task IN ('body_translation', 'body_repair') AND article_type IS NOT NULL)
  )
);

CREATE UNIQUE INDEX prompt_definitions_active_key_idx
  ON prompt_definitions (task, ifnull(article_type, ''), target_locale)
  WHERE deleted_at IS NULL;

CREATE TABLE prompt_versions (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES prompt_definitions(id),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived', 'deleted')),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  change_note TEXT,
  created_by_subject TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (definition_id, version)
);

CREATE UNIQUE INDEX prompt_versions_one_active_idx
  ON prompt_versions (definition_id) WHERE status = 'active';

CREATE TABLE prompt_change_logs (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES prompt_definitions(id),
  action TEXT NOT NULL CHECK (action IN ('create', 'edit', 'delete', 'publish', 'rollback')),
  before_version_id TEXT REFERENCES prompt_versions(id),
  after_version_id TEXT REFERENCES prompt_versions(id),
  actor_subject TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  change_note TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX prompt_change_logs_definition_idx ON prompt_change_logs (definition_id, created_at DESC);

CREATE TABLE ai_profile_versions (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL CHECK (profile IN ('fast', 'quality')),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'openai', 'anthropic', 'gemini', 'qwen_bailian')),
  protocol TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  region TEXT,
  workspace_id TEXT,
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  thinking_enabled INTEGER NOT NULL DEFAULT 0 CHECK (thinking_enabled IN (0, 1)),
  parameters_json TEXT NOT NULL DEFAULT '{}',
  created_by_subject TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (json_valid(parameters_json)),
  UNIQUE (profile, version)
);

CREATE UNIQUE INDEX ai_profile_versions_one_active_idx
  ON ai_profile_versions (profile) WHERE status = 'active';

CREATE TABLE system_config_versions (
  id TEXT PRIMARY KEY,
  config_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  value_json TEXT NOT NULL,
  created_by_subject TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (json_valid(value_json)),
  UNIQUE (config_key, version)
);

CREATE UNIQUE INDEX system_config_versions_one_active_idx
  ON system_config_versions (config_key) WHERE status = 'active';

CREATE TABLE article_classifications (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  article_type TEXT NOT NULL REFERENCES article_types(key),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason_summary TEXT,
  translated_title TEXT,
  title_status TEXT NOT NULL CHECK (title_status IN ('completed', 'failed', 'fallback')),
  source_hash TEXT NOT NULL,
  prompt_version_id TEXT REFERENCES prompt_versions(id),
  profile_version_id TEXT NOT NULL REFERENCES ai_profile_versions(id),
  sampling_algorithm_version TEXT NOT NULL,
  sampling_config_version_id TEXT REFERENCES system_config_versions(id),
  sample_fragment_count INTEGER NOT NULL CHECK (sample_fragment_count >= 0),
  sample_manifest_hash TEXT NOT NULL,
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX article_classifications_article_idx ON article_classifications (article_id, created_at DESC);

CREATE TABLE article_parse_tasks (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  error_message TEXT,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('system', 'admin')),
  requested_by_subject TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE UNIQUE INDEX article_parse_tasks_one_active_idx
  ON article_parse_tasks (article_id) WHERE status IN ('pending', 'running');

CREATE TABLE translations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  target_locale TEXT NOT NULL,
  article_type TEXT NOT NULL REFERENCES article_types(key),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancel_requested', 'cancelled', 'superseded')),
  source_hash TEXT NOT NULL,
  translated_title TEXT,
  prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id),
  title_profile_version_id TEXT NOT NULL REFERENCES ai_profile_versions(id),
  body_profile_version_id TEXT NOT NULL REFERENCES ai_profile_versions(id),
  parent_translation_id TEXT REFERENCES translations(id),
  trigger_reason TEXT NOT NULL,
  result_key TEXT,
  result_hash TEXT,
  result_bytes INTEGER CHECK (result_bytes IS NULL OR result_bytes >= 0),
  content_html_key TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_by TEXT NOT NULL CHECK (created_by IN ('client', 'admin', 'gpt_action', 'system')),
  created_by_subject TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE UNIQUE INDEX translations_version_idempotency_idx ON translations (
  article_id, target_locale, source_hash, article_type,
  prompt_version_id, title_profile_version_id, body_profile_version_id
);

CREATE UNIQUE INDEX translations_one_active_idx ON translations (article_id, target_locale, source_hash)
  WHERE status IN ('pending', 'running', 'cancel_requested');

CREATE INDEX translations_lookup_idx ON translations (article_id, target_locale, created_at DESC);

CREATE TABLE translation_attempts (
  id TEXT PRIMARY KEY,
  translation_id TEXT NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  workflow_instance_id TEXT,
  error_code TEXT,
  error_message TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  thinking_tokens INTEGER CHECK (thinking_tokens IS NULL OR thinking_tokens >= 0),
  provider_latency_ms INTEGER CHECK (provider_latency_ms IS NULL OR provider_latency_ms >= 0),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (translation_id, attempt)
);

CREATE TABLE translation_batches (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES translation_attempts(id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  partial_key TEXT,
  partial_hash TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (attempt_id, batch_index)
);

CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY,
  actor_subject TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  old_value_summary_json TEXT,
  new_value_summary_json TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (old_value_summary_json IS NULL OR json_valid(old_value_summary_json)),
  CHECK (new_value_summary_json IS NULL OR json_valid(new_value_summary_json))
);

CREATE INDEX admin_audit_logs_created_idx ON admin_audit_logs (created_at DESC);

CREATE TRIGGER prompt_change_logs_no_update
BEFORE UPDATE ON prompt_change_logs BEGIN
  SELECT RAISE(ABORT, 'prompt change logs are immutable');
END;

CREATE TRIGGER prompt_change_logs_no_delete
BEFORE DELETE ON prompt_change_logs BEGIN
  SELECT RAISE(ABORT, 'prompt change logs are immutable');
END;

CREATE TRIGGER admin_audit_logs_no_update
BEFORE UPDATE ON admin_audit_logs BEGIN
  SELECT RAISE(ABORT, 'admin audit logs are immutable');
END;

CREATE TRIGGER admin_audit_logs_no_delete
BEFORE DELETE ON admin_audit_logs BEGIN
  SELECT RAISE(ABORT, 'admin audit logs are immutable');
END;
