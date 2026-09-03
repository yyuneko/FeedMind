ALTER TABLE gpt_action_usage RENAME TO gpt_action_usage_legacy_0029;

CREATE TABLE gpt_action_usage (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('requests', 'writes', 'translations')),
  value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, usage_date, metric)
);

DROP TABLE gpt_action_usage_legacy_0029;

-- Fixed GPT Action API keys are intentionally unsupported after this migration.
DROP TABLE gpt_api_clients;

CREATE TABLE gpt_oauth_authorization_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT CHECK (code_challenge_method IS NULL OR code_challenge_method = 'S256'),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX gpt_oauth_codes_expiry_idx
  ON gpt_oauth_authorization_codes(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE gpt_oauth_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_token_hash TEXT UNIQUE,
  refresh_expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX gpt_oauth_access_token_idx
  ON gpt_oauth_sessions(access_token_hash, access_expires_at) WHERE revoked_at IS NULL;

CREATE INDEX gpt_oauth_refresh_token_idx
  ON gpt_oauth_sessions(refresh_token_hash, refresh_expires_at) WHERE revoked_at IS NULL;
