PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS local_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_run_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS local_jobs_due_idx
  ON local_jobs(status, next_run_at, created_at);
CREATE INDEX IF NOT EXISTS local_jobs_lease_idx
  ON local_jobs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS local_workflow_instances (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS local_workflow_steps (
  workflow_id TEXT NOT NULL REFERENCES local_workflow_instances(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, step_name)
);

CREATE TABLE IF NOT EXISTS local_rate_limits (
  bucket_key TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_started_at)
);
