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

CREATE INDEX translation_diagnostics_translation_idx
  ON translation_diagnostics (translation_id, created_at DESC);

CREATE INDEX translation_diagnostics_attempt_idx
  ON translation_diagnostics (attempt_id, batch_index, created_at DESC);
