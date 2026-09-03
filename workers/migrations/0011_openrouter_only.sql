PRAGMA defer_foreign_keys = ON;

UPDATE ai_profile_versions
SET status = 'archived',
    deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE provider <> 'openrouter';

CREATE TABLE ai_profile_versions_openrouter (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL CHECK (profile IN ('fast', 'quality')),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'openai', 'anthropic', 'gemini', 'qwen_bailian', 'openrouter')),
  protocol TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  region TEXT,
  workspace_id TEXT,
  max_output_tokens INTEGER CHECK (max_output_tokens > 0),
  thinking_enabled INTEGER NOT NULL DEFAULT 0 CHECK (thinking_enabled IN (0, 1)),
  parameters_json TEXT NOT NULL DEFAULT '{}',
  created_by_subject TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (json_valid(parameters_json)),
  UNIQUE (profile, version)
);

INSERT INTO ai_profile_versions_openrouter (
  id, profile, version, status, provider, protocol, endpoint, model, region, workspace_id,
  max_output_tokens, thinking_enabled, parameters_json, created_by_subject, created_by_email,
  created_at, deleted_at
)
SELECT
  id, profile, version, status, provider, protocol, endpoint, model, region, workspace_id,
  max_output_tokens, thinking_enabled, parameters_json, created_by_subject, created_by_email,
  created_at, deleted_at
FROM ai_profile_versions;

DROP TABLE ai_profile_versions;
ALTER TABLE ai_profile_versions_openrouter RENAME TO ai_profile_versions;

CREATE UNIQUE INDEX ai_profile_versions_one_active_idx
  ON ai_profile_versions (profile) WHERE status = 'active';

CREATE INDEX ai_profile_versions_visible_idx
  ON ai_profile_versions (profile, version DESC) WHERE deleted_at IS NULL;

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = OFF;
