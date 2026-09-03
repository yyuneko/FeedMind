PRAGMA defer_foreign_keys = ON;

-- A failed attempt must not permanently occupy the reusable result fingerprint.
-- Preserve its original fingerprint as a prefix while making the attempt identity unique.
UPDATE article_preprocessing_runs
SET status = 'failed',
    result_fingerprint = result_fingerprint || ':failed:' || id,
    error_code = 'workflow_interrupted',
    error_message = 'Preprocessing workflow did not complete',
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'running' AND julianday(created_at) < julianday('now', '-10 minutes');

UPDATE article_preprocessing_runs
SET result_fingerprint = result_fingerprint || ':failed:' || id
WHERE status = 'failed'
  AND substr(result_fingerprint, -(length(id) + 8)) <> ':failed:' || id;

UPDATE article_preprocessing_tasks
SET status = 'failed', error_code = 'workflow_interrupted',
    error_message = 'Preprocessing workflow did not complete',
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'running' AND julianday(started_at) < julianday('now', '-10 minutes');

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = OFF;

