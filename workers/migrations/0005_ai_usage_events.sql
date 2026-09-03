CREATE TABLE ai_usage_events (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('classification_title', 'body_translation', 'thinking_coach', 'prompt_test', 'profile_test')),
  profile_version_id TEXT REFERENCES ai_profile_versions(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  article_id TEXT REFERENCES articles(id) ON DELETE SET NULL,
  translation_id TEXT REFERENCES translations(id) ON DELETE SET NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  thinking_tokens INTEGER NOT NULL DEFAULT 0 CHECK (thinking_tokens >= 0),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  error_code TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX ai_usage_events_created_idx ON ai_usage_events (created_at DESC);
CREATE INDEX ai_usage_events_profile_idx ON ai_usage_events (profile_version_id, created_at DESC);

CREATE TRIGGER ai_usage_events_no_update
BEFORE UPDATE ON ai_usage_events BEGIN SELECT RAISE(ABORT, 'ai usage events are immutable'); END;

CREATE TRIGGER ai_usage_events_no_delete
BEFORE DELETE ON ai_usage_events BEGIN SELECT RAISE(ABORT, 'ai usage events are immutable'); END;
