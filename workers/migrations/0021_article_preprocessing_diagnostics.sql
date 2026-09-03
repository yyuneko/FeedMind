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

CREATE INDEX article_preprocessing_diagnostics_task_idx
  ON article_preprocessing_diagnostics (task_id, created_at DESC);

