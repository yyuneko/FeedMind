ALTER TABLE article_classifications ADD COLUMN title_prompt_version_id TEXT REFERENCES prompt_versions(id);
ALTER TABLE article_classifications ADD COLUMN title_profile_version_id TEXT REFERENCES ai_profile_versions(id);
ALTER TABLE article_classifications ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1));

ALTER TABLE translations ADD COLUMN workflow_instance_id TEXT;
ALTER TABLE translations ADD COLUMN cancel_requested_at TEXT;

CREATE UNIQUE INDEX article_classifications_source_idx
  ON article_classifications (article_id, source_hash) WHERE is_current = 1;

CREATE TABLE idempotency_requests (
  owner_id TEXT NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  surface TEXT NOT NULL CHECK (surface IN ('client', 'admin', 'gpt_action')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (json_valid(response_json)),
  PRIMARY KEY (owner_id, surface, idempotency_key)
);

CREATE INDEX idempotency_requests_expiry_idx ON idempotency_requests (expires_at);

CREATE TABLE gpt_action_usage (
  usage_date TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('requests', 'writes', 'translations')),
  value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, metric)
);

INSERT INTO system_config_versions
  (id, config_key, version, status, value_json, created_by_subject, created_by_email, created_at)
VALUES
  ('8df22700-51e3-4b3a-9401-1fdd24745cf4', 'classification_sampling', 1, 'active',
   '{"algorithmVersion":"paragraph-dispersed-v1","bodyTokenBudget":3000,"headRatio":0.25,"middleRatio":0.6,"tailRatio":0.15,"middleWindows":4,"minimumBudget":500,"maximumBudget":8000}',
   'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('3a3bd229-a6ce-4206-b7fc-f8a4ced7e36e', 'classification_threshold', 1, 'active',
   '{"minimumConfidence":0.65}', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('81b4228e-9c00-4198-ac95-4ff0cd9898ce', 'translation_limits', 1, 'active',
   '{"batchTokenBudget":6000,"maxRetries":3,"baseRetrySeconds":30}',
   'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
