-- Rebuild the complete foreign-key dependency graph so D1 never cascades
-- production rows while owner_id CHECK constraints are removed.
PRAGMA defer_foreign_keys = ON;
PRAGMA legacy_alter_table = ON;

ALTER TABLE feeds RENAME TO feeds_legacy_0025;
ALTER TABLE idempotency_requests RENAME TO idempotency_requests_legacy_0025;
ALTER TABLE preferences RENAME TO preferences_legacy_0025;
ALTER TABLE prompts RENAME TO prompts_legacy_0025;
ALTER TABLE articles RENAME TO articles_legacy_0025;
ALTER TABLE feed_extraction_rules RENAME TO feed_extraction_rules_legacy_0025;
ALTER TABLE feed_noise_patterns RENAME TO feed_noise_patterns_legacy_0025;
ALTER TABLE sources RENAME TO sources_legacy_0025;
ALTER TABLE subscriptions RENAME TO subscriptions_legacy_0025;
ALTER TABLE article_content_blocks RENAME TO article_content_blocks_legacy_0025;
ALTER TABLE article_parse_tasks RENAME TO article_parse_tasks_legacy_0025;
ALTER TABLE article_preprocessing_tasks RENAME TO article_preprocessing_tasks_legacy_0025;
ALTER TABLE article_source_block_alignments RENAME TO article_source_block_alignments_legacy_0025;
ALTER TABLE article_state_operations RENAME TO article_state_operations_legacy_0025;
ALTER TABLE article_states RENAME TO article_states_legacy_0025;
ALTER TABLE feed_extraction_rule_versions RENAME TO feed_extraction_rule_versions_legacy_0025;
ALTER TABLE source_categories RENAME TO source_categories_legacy_0025;
ALTER TABLE source_items RENAME TO source_items_legacy_0025;
ALTER TABLE thinking_sessions RENAME TO thinking_sessions_legacy_0025;
ALTER TABLE translations RENAME TO translations_legacy_0025;
ALTER TABLE article_preprocessing_runs RENAME TO article_preprocessing_runs_legacy_0025;
ALTER TABLE feed_extraction_rule_validations RENAME TO feed_extraction_rule_validations_legacy_0025;
ALTER TABLE state_sync_outbox RENAME TO state_sync_outbox_legacy_0025;
ALTER TABLE thinking_events RENAME TO thinking_events_legacy_0025;
ALTER TABLE translation_attempts RENAME TO translation_attempts_legacy_0025;
ALTER TABLE ai_usage_events RENAME TO ai_usage_events_legacy_0025;
ALTER TABLE article_classifications RENAME TO article_classifications_legacy_0025;
ALTER TABLE article_information_scores RENAME TO article_information_scores_legacy_0025;
ALTER TABLE article_preprocessing_diagnostics RENAME TO article_preprocessing_diagnostics_legacy_0025;
ALTER TABLE article_preprocessing_locales RENAME TO article_preprocessing_locales_legacy_0025;
ALTER TABLE article_topic_tags RENAME TO article_topic_tags_legacy_0025;
ALTER TABLE translation_batches RENAME TO translation_batches_legacy_0025;
ALTER TABLE translation_diagnostics RENAME TO translation_diagnostics_legacy_0025;
ALTER TABLE article_title_translations RENAME TO article_title_translations_legacy_0025;

CREATE TABLE feeds (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', site_url TEXT, description TEXT, etag TEXT, last_modified TEXT,
  fetch_status TEXT NOT NULL DEFAULT 'pending' CHECK (fetch_status IN ('pending','running','succeeded','failed')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0), last_error_code TEXT, last_fetched_at TEXT,
  next_fetch_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, url)
);

CREATE TABLE idempotency_requests (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  surface TEXT NOT NULL CHECK (surface IN ('client','admin','gpt_action')), idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, response_status INTEGER NOT NULL, response_json TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, CHECK (json_valid(response_json)),
  PRIMARY KEY(owner_id, surface, idempotency_key)
);

CREATE TABLE preferences (
  owner_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, locale TEXT NOT NULL DEFAULT 'zh-CN',
  target_locale TEXT NOT NULL DEFAULT 'zh-CN', settings_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
  CHECK (json_valid(settings_json))
);

CREATE TABLE prompts (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE articles (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  feed_id TEXT REFERENCES feeds(id) ON DELETE SET NULL, canonical_url TEXT NOT NULL, external_id TEXT,
  title TEXT NOT NULL DEFAULT '', author TEXT, summary TEXT, published_at TEXT, source_hash TEXT,
  source_html_key TEXT, source_html_hash TEXT, source_html_bytes INTEGER CHECK (source_html_bytes IS NULL OR source_html_bytes >= 0),
  source_text_key TEXT, source_text_hash TEXT, source_text_bytes INTEGER CHECK (source_text_bytes IS NULL OR source_text_bytes >= 0),
  source_mime_type TEXT, parse_status TEXT NOT NULL DEFAULT 'pending' CHECK (parse_status IN ('pending','running','completed','failed')),
  parsed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, thumbnail_url TEXT,
  parser_version INTEGER NOT NULL DEFAULT 1 CHECK (parser_version > 0), parse_error TEXT,
  noise_manifest_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(noise_manifest_json)), noise_manifest_hash TEXT,
  noise_analyzed_at TEXT, extraction_rule_version_id TEXT,
  extraction_strategy TEXT NOT NULL DEFAULT 'readability' CHECK (extraction_strategy IN ('site_rule','readability','readability_fallback')),
  extraction_diagnostic_code TEXT, UNIQUE(owner_id, canonical_url)
);

CREATE TABLE feed_extraction_rules (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL UNIQUE REFERENCES feeds(id) ON DELETE CASCADE,
  draft_version_id TEXT,
  active_version_id TEXT,
  created_by_subject TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE feed_noise_patterns (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  representative_fingerprint TEXT NOT NULL,
  representative_sketch_json TEXT NOT NULL CHECK (json_valid(representative_sketch_json)),
  match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'similar')),
  support_count INTEGER NOT NULL CHECK (support_count > 0),
  window_article_count INTEGER NOT NULL CHECK (window_article_count > 0),
  frequency REAL NOT NULL CHECK (frequency >= 0 AND frequency <= 1),
  position_consistency REAL NOT NULL CHECK (position_consistency >= 0 AND position_consistency <= 1),
  policy_version TEXT NOT NULL,
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  UNIQUE (feed_id, representative_fingerprint, match_kind, policy_version)
);

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

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, category TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  custom_title TEXT, sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0), UNIQUE(owner_id, feed_id)
);

CREATE TABLE article_content_blocks (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  stable_id TEXT NOT NULL,
  block_index INTEGER NOT NULL CHECK (block_index >= 0),
  block_kind TEXT NOT NULL,
  relative_position REAL NOT NULL CHECK (relative_position >= 0 AND relative_position <= 1),
  normalized_length INTEGER NOT NULL CHECK (normalized_length >= 0),
  exact_fingerprint TEXT NOT NULL,
  similarity_sketch_json TEXT NOT NULL CHECK (json_valid(similarity_sketch_json)),
  is_protected INTEGER NOT NULL CHECK (is_protected IN (0, 1)),
  is_eligible INTEGER NOT NULL CHECK (is_eligible IN (0, 1)),
  noise_pattern_id TEXT,
  decision_kind TEXT CHECK (decision_kind IS NULL OR decision_kind IN ('exact', 'similar')),
  support_count INTEGER,
  window_article_count INTEGER,
  frequency REAL,
  position_consistency REAL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  marked_at TEXT,
  UNIQUE (article_id, source_hash, stable_id)
);

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
, heartbeat_at TEXT);

CREATE TABLE article_preprocessing_tasks (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  source_text_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('system', 'admin')),
  requested_by_subject TEXT,
  request_id TEXT NOT NULL,
  workflow_instance_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE article_source_block_alignments (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  from_source_hash TEXT NOT NULL,
  to_source_hash TEXT NOT NULL,
  mapping_json TEXT NOT NULL CHECK (json_valid(mapping_json)),
  current_coverage REAL NOT NULL CHECK (current_coverage >= 0 AND current_coverage <= 1),
  is_ambiguous INTEGER NOT NULL CHECK (is_ambiguous IN (0, 1)),
  algorithm_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (article_id, from_source_hash, to_source_hash)
);

CREATE TABLE article_state_operations (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, operation_id TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, operation_id)
);

CREATE TABLE article_states (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)), is_saved INTEGER NOT NULL DEFAULT 0 CHECK (is_saved IN (0,1)),
  reading_progress REAL NOT NULL DEFAULT 0 CHECK (reading_progress >= 0 AND reading_progress <= 1),
  read_at TEXT, saved_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, article_id)
);

CREATE TABLE feed_extraction_rule_versions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES feed_extraction_rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  rule_json TEXT NOT NULL CHECK (json_valid(rule_json)),
  config_hash TEXT NOT NULL,
  change_note TEXT,
  created_by_subject TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (rule_id, version)
);

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

CREATE TABLE thinking_sessions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id TEXT REFERENCES articles(id) ON DELETE SET NULL, status TEXT NOT NULL CHECK (status IN ('active','completed','abandoned')),
  summary TEXT, created_at TEXT NOT NULL, completed_at TEXT, article_content_hash TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'summary', completed_rounds INTEGER NOT NULL DEFAULT 0,
  coverage_json TEXT NOT NULL DEFAULT '{}', coach_state_json TEXT NOT NULL DEFAULT '{}', report_json TEXT,
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, CHECK (json_valid(coverage_json)), CHECK (json_valid(coach_state_json))
);

CREATE TABLE translations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE, target_locale TEXT NOT NULL,
  article_type TEXT NOT NULL REFERENCES article_types(key),
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancel_requested','cancelled','superseded')),
  source_hash TEXT NOT NULL, translated_title TEXT, prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id),
  title_profile_version_id TEXT NOT NULL REFERENCES ai_profile_versions(id), body_profile_version_id TEXT NOT NULL REFERENCES ai_profile_versions(id),
  parent_translation_id TEXT REFERENCES translations(id), trigger_reason TEXT NOT NULL, result_key TEXT, result_hash TEXT,
  result_bytes INTEGER CHECK (result_bytes IS NULL OR result_bytes >= 0), content_html_key TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_by TEXT NOT NULL CHECK (created_by IN ('client','admin','gpt_action','system')), created_by_subject TEXT,
  request_id TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
  workflow_instance_id TEXT, cancel_requested_at TEXT,
  noise_manifest_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(noise_manifest_json)), noise_manifest_hash TEXT
);

CREATE TABLE article_preprocessing_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES article_preprocessing_tasks(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  source_text_hash TEXT NOT NULL,
  result_fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  prompt_bundle_hash TEXT NOT NULL,
  preprocessing_prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id),
  classification_prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id),
  profile_version_id TEXT NOT NULL REFERENCES ai_profile_versions(id),
  tag_vocabulary_version INTEGER NOT NULL DEFAULT 1 CHECK (tag_vocabulary_version > 0),
  context_window_tokens INTEGER NOT NULL CHECK (context_window_tokens > 0),
  source_text_bytes INTEGER NOT NULL CHECK (source_text_bytes >= 0),
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens > 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  thinking_tokens INTEGER CHECK (thinking_tokens IS NULL OR thinking_tokens >= 0),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
, tag_vocabulary_hash TEXT, profile_config_hash TEXT);

CREATE TABLE feed_extraction_rule_validations (
  id TEXT PRIMARY KEY,
  rule_version_id TEXT NOT NULL REFERENCES feed_extraction_rule_versions(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  config_hash TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  confirmed_by_subject TEXT NOT NULL,
  confirmed_by_email TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  UNIQUE (rule_version_id, article_id)
);

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

CREATE TABLE "ai_usage_events" (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('classification_title', 'article_preprocessing', 'body_translation',
    'thinking_coach', 'prompt_test', 'profile_test')),
  profile_version_id TEXT REFERENCES ai_profile_versions(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  article_id TEXT REFERENCES articles(id) ON DELETE SET NULL,
  translation_id TEXT REFERENCES translations(id) ON DELETE SET NULL,
  preprocessing_run_id TEXT REFERENCES article_preprocessing_runs(id) ON DELETE SET NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  thinking_tokens INTEGER NOT NULL DEFAULT 0 CHECK (thinking_tokens >= 0),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  error_code TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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
, title_prompt_version_id TEXT REFERENCES prompt_versions(id), title_profile_version_id TEXT REFERENCES ai_profile_versions(id), is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)), title_translation_policy_version INTEGER NOT NULL DEFAULT 1
CHECK (title_translation_policy_version >= 1), preprocessing_run_id TEXT
  REFERENCES article_preprocessing_runs(id) ON DELETE SET NULL, source_title_locale TEXT
  CHECK (source_title_locale IS NULL OR source_title_locale IN ('zh-CN', 'en-US', 'ja-JP', 'other')));

CREATE TABLE article_information_scores (
  run_id TEXT PRIMARY KEY REFERENCES article_preprocessing_runs(id) ON DELETE CASCADE,
  total_score INTEGER NOT NULL CHECK (total_score >= 0 AND total_score <= 100),
  dimensions_json TEXT NOT NULL CHECK (json_valid(dimensions_json)),
  reason TEXT NOT NULL
);

CREATE TABLE article_preprocessing_diagnostics (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES article_preprocessing_tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES article_preprocessing_runs(id) ON DELETE SET NULL,
  diagnostic_object_key TEXT NOT NULL,
  response_status INTEGER,
  error_code TEXT NOT NULL,
  error_message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE article_preprocessing_locales (
  run_id TEXT NOT NULL REFERENCES article_preprocessing_runs(id) ON DELETE CASCADE,
  target_locale TEXT NOT NULL CHECK (target_locale IN ('zh-CN', 'en-US', 'ja-JP')),
  translated_title TEXT NOT NULL,
  one_line_summary TEXT NOT NULL,
  key_points_json TEXT NOT NULL CHECK (json_valid(key_points_json)),
  PRIMARY KEY (run_id, target_locale)
);

CREATE TABLE article_topic_tags (
  run_id TEXT NOT NULL REFERENCES article_preprocessing_runs(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES topic_tags(id),
  rank INTEGER NOT NULL CHECK (rank > 0),
  PRIMARY KEY (run_id, tag_id),
  UNIQUE (run_id, rank)
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

CREATE TABLE translation_diagnostics (
  id TEXT PRIMARY KEY,
  translation_id TEXT NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES translation_attempts(id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
  failure_stage TEXT NOT NULL CHECK (failure_stage IN ('api_response', 'response_parse', 'workflow_failure')),
  provider_response_key TEXT NOT NULL,
  error_code TEXT NOT NULL,
  error_message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE article_title_translations (
  classification_id TEXT NOT NULL REFERENCES article_classifications(id) ON DELETE CASCADE,
  target_locale TEXT NOT NULL CHECK (target_locale IN ('zh-CN', 'en-US', 'ja-JP')),
  translated_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'fallback')),
  prompt_version_id TEXT REFERENCES prompt_versions(id),
  profile_version_id TEXT NOT NULL REFERENCES ai_profile_versions(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (classification_id, target_locale)
);

INSERT INTO feeds SELECT * FROM feeds_legacy_0025;
INSERT INTO idempotency_requests SELECT * FROM idempotency_requests_legacy_0025;
INSERT INTO preferences SELECT * FROM preferences_legacy_0025;
INSERT INTO prompts SELECT * FROM prompts_legacy_0025;
INSERT INTO articles SELECT * FROM articles_legacy_0025;
INSERT INTO feed_extraction_rules SELECT * FROM feed_extraction_rules_legacy_0025;
INSERT INTO feed_noise_patterns SELECT * FROM feed_noise_patterns_legacy_0025;
INSERT INTO sources SELECT * FROM sources_legacy_0025;
INSERT INTO subscriptions SELECT * FROM subscriptions_legacy_0025;
INSERT INTO article_content_blocks SELECT * FROM article_content_blocks_legacy_0025;
INSERT INTO article_parse_tasks SELECT * FROM article_parse_tasks_legacy_0025;
INSERT INTO article_preprocessing_tasks SELECT * FROM article_preprocessing_tasks_legacy_0025;
INSERT INTO article_source_block_alignments SELECT * FROM article_source_block_alignments_legacy_0025;
INSERT INTO article_state_operations SELECT * FROM article_state_operations_legacy_0025;
INSERT INTO article_states SELECT * FROM article_states_legacy_0025;
INSERT INTO feed_extraction_rule_versions SELECT * FROM feed_extraction_rule_versions_legacy_0025;
INSERT INTO source_categories SELECT * FROM source_categories_legacy_0025;
INSERT INTO source_items SELECT * FROM source_items_legacy_0025;
INSERT INTO thinking_sessions SELECT * FROM thinking_sessions_legacy_0025;
INSERT INTO translations SELECT * FROM translations_legacy_0025;
INSERT INTO article_preprocessing_runs SELECT * FROM article_preprocessing_runs_legacy_0025;
INSERT INTO feed_extraction_rule_validations SELECT * FROM feed_extraction_rule_validations_legacy_0025;
INSERT INTO state_sync_outbox SELECT * FROM state_sync_outbox_legacy_0025;
INSERT INTO thinking_events SELECT * FROM thinking_events_legacy_0025;
INSERT INTO translation_attempts SELECT * FROM translation_attempts_legacy_0025;
INSERT INTO ai_usage_events SELECT * FROM ai_usage_events_legacy_0025;
INSERT INTO article_classifications SELECT * FROM article_classifications_legacy_0025;
INSERT INTO article_information_scores SELECT * FROM article_information_scores_legacy_0025;
INSERT INTO article_preprocessing_diagnostics SELECT * FROM article_preprocessing_diagnostics_legacy_0025;
INSERT INTO article_preprocessing_locales SELECT * FROM article_preprocessing_locales_legacy_0025;
INSERT INTO article_topic_tags SELECT * FROM article_topic_tags_legacy_0025;
INSERT INTO translation_batches SELECT * FROM translation_batches_legacy_0025;
INSERT INTO translation_diagnostics SELECT * FROM translation_diagnostics_legacy_0025;
INSERT INTO article_title_translations SELECT * FROM article_title_translations_legacy_0025;

DROP TRIGGER ai_usage_events_no_delete;
DROP TRIGGER ai_usage_events_no_update;

DROP TABLE article_title_translations_legacy_0025;
DROP TABLE translation_diagnostics_legacy_0025;
DROP TABLE translation_batches_legacy_0025;
DROP TABLE article_topic_tags_legacy_0025;
DROP TABLE article_preprocessing_locales_legacy_0025;
DROP TABLE article_preprocessing_diagnostics_legacy_0025;
DROP TABLE article_information_scores_legacy_0025;
DROP TABLE article_classifications_legacy_0025;
DROP TABLE ai_usage_events_legacy_0025;
DROP TABLE translation_attempts_legacy_0025;
DROP TABLE thinking_events_legacy_0025;
DROP TABLE state_sync_outbox_legacy_0025;
DROP TABLE feed_extraction_rule_validations_legacy_0025;
DROP TABLE article_preprocessing_runs_legacy_0025;
DROP TABLE translations_legacy_0025;
DROP TABLE thinking_sessions_legacy_0025;
DROP TABLE source_items_legacy_0025;
DROP TABLE source_categories_legacy_0025;
DROP TABLE feed_extraction_rule_versions_legacy_0025;
DROP TABLE article_states_legacy_0025;
DROP TABLE article_state_operations_legacy_0025;
DROP TABLE article_source_block_alignments_legacy_0025;
DROP TABLE article_preprocessing_tasks_legacy_0025;
DROP TABLE article_parse_tasks_legacy_0025;
DROP TABLE article_content_blocks_legacy_0025;
DROP TABLE subscriptions_legacy_0025;
DROP TABLE sources_legacy_0025;
DROP TABLE feed_noise_patterns_legacy_0025;
DROP TABLE feed_extraction_rules_legacy_0025;
DROP TABLE articles_legacy_0025;
DROP TABLE prompts_legacy_0025;
DROP TABLE preferences_legacy_0025;
DROP TABLE idempotency_requests_legacy_0025;
DROP TABLE feeds_legacy_0025;

CREATE INDEX ai_usage_events_created_idx ON ai_usage_events (created_at DESC);

CREATE INDEX ai_usage_events_profile_idx ON ai_usage_events (profile_version_id, created_at DESC);

CREATE INDEX article_classifications_article_idx ON article_classifications (article_id, created_at DESC);

CREATE UNIQUE INDEX article_classifications_source_idx
  ON article_classifications (article_id, source_hash) WHERE is_current = 1;

CREATE INDEX article_content_blocks_exact_idx
  ON article_content_blocks (feed_id, exact_fingerprint) WHERE is_eligible = 1;

CREATE INDEX article_content_blocks_feed_source_idx
  ON article_content_blocks (feed_id, source_hash, article_id);

CREATE INDEX article_content_blocks_noise_idx
  ON article_content_blocks (article_id, source_hash) WHERE noise_pattern_id IS NOT NULL;

CREATE UNIQUE INDEX article_parse_tasks_one_active_idx
  ON article_parse_tasks (article_id) WHERE status IN ('pending', 'running');

CREATE INDEX article_preprocessing_diagnostics_task_idx
  ON article_preprocessing_diagnostics (task_id, created_at DESC);

CREATE INDEX article_preprocessing_runs_article_idx
  ON article_preprocessing_runs (article_id, created_at DESC);

CREATE UNIQUE INDEX article_preprocessing_runs_current_idx
  ON article_preprocessing_runs (article_id, source_text_hash) WHERE is_current = 1;

CREATE UNIQUE INDEX article_preprocessing_tasks_one_active_idx
  ON article_preprocessing_tasks (article_id, source_text_hash)
  WHERE status IN ('pending', 'running');

CREATE INDEX article_preprocessing_tasks_status_idx
  ON article_preprocessing_tasks (status, created_at);

CREATE INDEX article_title_translations_locale_idx
  ON article_title_translations (target_locale, classification_id);

CREATE INDEX articles_feed_published_idx ON articles (feed_id, published_at DESC);

CREATE INDEX articles_owner_published_idx ON articles (owner_id, published_at DESC);

CREATE INDEX feed_extraction_rule_validations_version_idx
  ON feed_extraction_rule_validations (rule_version_id, confirmed_at DESC);

CREATE UNIQUE INDEX feed_extraction_rule_versions_one_active_idx
  ON feed_extraction_rule_versions (rule_id) WHERE status = 'active';

CREATE UNIQUE INDEX feed_extraction_rule_versions_one_draft_idx
  ON feed_extraction_rule_versions (rule_id) WHERE status = 'draft';

CREATE INDEX feed_noise_patterns_feed_idx ON feed_noise_patterns (feed_id, last_detected_at DESC);

CREATE INDEX feeds_due_idx ON feeds (next_fetch_at) WHERE fetch_status <> 'running';

CREATE INDEX idempotency_requests_expiry_idx ON idempotency_requests (expires_at);

CREATE INDEX source_items_article_idx ON source_items(article_id, source_id);

CREATE INDEX source_items_source_idx ON source_items(source_id, last_seen_at DESC);

CREATE INDEX sources_owner_idx ON sources(owner_id, enabled, lower(title));

CREATE INDEX state_sync_outbox_due_idx ON state_sync_outbox(connection_id, next_attempt_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX subscriptions_owner_sort_idx
  ON subscriptions (owner_id, sort_order, created_at);

CREATE INDEX thinking_sessions_article_idx ON thinking_sessions (owner_id, article_id, created_at DESC);

CREATE INDEX translation_diagnostics_attempt_idx
  ON translation_diagnostics (attempt_id, batch_index, created_at DESC);

CREATE INDEX translation_diagnostics_translation_idx
  ON translation_diagnostics (translation_id, created_at DESC);

CREATE INDEX translations_lookup_idx ON translations (article_id, target_locale, created_at DESC);

CREATE UNIQUE INDEX translations_one_active_idx ON translations (article_id, target_locale, source_hash)
  WHERE status IN ('pending', 'running', 'cancel_requested');

CREATE UNIQUE INDEX translations_version_idempotency_idx ON translations (
  article_id, target_locale, source_hash, article_type,
  prompt_version_id, title_profile_version_id, body_profile_version_id
);

CREATE TRIGGER ai_usage_events_no_delete
BEFORE DELETE ON ai_usage_events BEGIN SELECT RAISE(ABORT, 'ai usage events are immutable'); END;

CREATE TRIGGER ai_usage_events_no_update
BEFORE UPDATE ON ai_usage_events BEGIN SELECT RAISE(ABORT, 'ai usage events are immutable'); END;

PRAGMA legacy_alter_table = OFF;
PRAGMA defer_foreign_keys = OFF;
PRAGMA foreign_key_check;
