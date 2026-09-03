PRAGMA defer_foreign_keys = ON;

ALTER TABLE ai_profile_versions ADD COLUMN context_window_tokens INTEGER
  CHECK (context_window_tokens IS NULL OR context_window_tokens > 0);
ALTER TABLE ai_profile_versions ADD COLUMN canonical_model TEXT;
ALTER TABLE ai_profile_versions ADD COLUMN model_metadata_fetched_at TEXT;

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

CREATE UNIQUE INDEX article_preprocessing_tasks_one_active_idx
  ON article_preprocessing_tasks (article_id, source_text_hash)
  WHERE status IN ('pending', 'running');
CREATE INDEX article_preprocessing_tasks_status_idx
  ON article_preprocessing_tasks (status, created_at);

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
);

CREATE UNIQUE INDEX article_preprocessing_runs_current_idx
  ON article_preprocessing_runs (article_id, source_text_hash) WHERE is_current = 1;
CREATE INDEX article_preprocessing_runs_article_idx
  ON article_preprocessing_runs (article_id, created_at DESC);

CREATE TABLE article_preprocessing_locales (
  run_id TEXT NOT NULL REFERENCES article_preprocessing_runs(id) ON DELETE CASCADE,
  target_locale TEXT NOT NULL CHECK (target_locale IN ('zh-CN', 'en-US', 'ja-JP')),
  translated_title TEXT NOT NULL,
  one_line_summary TEXT NOT NULL,
  key_points_json TEXT NOT NULL CHECK (json_valid(key_points_json)),
  PRIMARY KEY (run_id, target_locale)
);

CREATE TABLE article_information_scores (
  run_id TEXT PRIMARY KEY REFERENCES article_preprocessing_runs(id) ON DELETE CASCADE,
  total_score INTEGER NOT NULL CHECK (total_score >= 0 AND total_score <= 100),
  dimensions_json TEXT NOT NULL CHECK (json_valid(dimensions_json)),
  reason TEXT NOT NULL
);

CREATE TABLE topic_tags (
  id TEXT PRIMARY KEY,
  tag_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'deprecated')),
  names_json TEXT NOT NULL CHECK (json_valid(names_json)),
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  vocabulary_version INTEGER NOT NULL DEFAULT 1 CHECK (vocabulary_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE article_topic_tags (
  run_id TEXT NOT NULL REFERENCES article_preprocessing_runs(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES topic_tags(id),
  rank INTEGER NOT NULL CHECK (rank > 0),
  PRIMARY KEY (run_id, tag_id),
  UNIQUE (run_id, rank)
);

ALTER TABLE article_classifications ADD COLUMN preprocessing_run_id TEXT
  REFERENCES article_preprocessing_runs(id) ON DELETE SET NULL;
ALTER TABLE ai_usage_events ADD COLUMN preprocessing_run_id TEXT
  REFERENCES article_preprocessing_runs(id) ON DELETE SET NULL;

DROP TRIGGER ai_usage_events_no_update;
DROP TRIGGER ai_usage_events_no_delete;
DROP INDEX ai_usage_events_created_idx;
DROP INDEX ai_usage_events_profile_idx;

CREATE TABLE ai_usage_events_unified (
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

INSERT INTO ai_usage_events_unified SELECT id, purpose, profile_version_id, provider, model, status,
  article_id, translation_id, preprocessing_run_id, input_tokens, output_tokens, thinking_tokens,
  latency_ms, error_code, request_id, created_at FROM ai_usage_events;
DROP TABLE ai_usage_events;
ALTER TABLE ai_usage_events_unified RENAME TO ai_usage_events;
CREATE INDEX ai_usage_events_created_idx ON ai_usage_events (created_at DESC);
CREATE INDEX ai_usage_events_profile_idx ON ai_usage_events (profile_version_id, created_at DESC);
CREATE TRIGGER ai_usage_events_no_update
BEFORE UPDATE ON ai_usage_events BEGIN SELECT RAISE(ABORT, 'ai usage events are immutable'); END;
CREATE TRIGGER ai_usage_events_no_delete
BEFORE DELETE ON ai_usage_events BEGIN SELECT RAISE(ABORT, 'ai usage events are immutable'); END;

INSERT INTO system_config_versions
  (id, config_key, version, status, value_json, created_by_subject, created_by_email, created_at)
VALUES
  ('5f23e8ec-91c5-4f33-a17d-b147a256f401', 'article_preprocessing_limits', 1, 'active',
   '{"reservedOutputTokens":1800,"tokenSafetyMultiplier":1.2,"maxAdminBatch":50}',
   'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO prompt_definitions
  (id, task, article_type, target_locale, current_version_id, created_at, updated_at)
VALUES
  ('10000000-0000-4000-8000-000000000011', 'classification', NULL, 'preprocessing',
   '20000000-0000-4000-8000-000000000012',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO prompt_versions
  (id, definition_id, version, status, content, content_hash, change_note,
   created_by_subject, created_by_email, created_at)
VALUES
  ('20000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000011', 1, 'active',
   '正文是已去除 HTML 标签的完整纯文本。基于全文同时完成分类、标题翻译、摘要、关键要点、信息量评分和主题标签。不得补充正文不存在的信息。摘要必须是一句话；每种语言输出 3 至 5 条最重要要点。信息量评分关注具体性、技术细节、实践经验、数据证据和新增信息，简单公告、营销和重复转述应低分。返回严格符合调用方要求的单个 JSON 对象。',
   'seed-article-preprocessing-v1', '统一全文 AI 预处理', 'system', 'system@feedmind.local',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = OFF;
