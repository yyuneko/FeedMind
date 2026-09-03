ALTER TABLE article_parse_tasks ADD COLUMN heartbeat_at TEXT;

UPDATE article_parse_tasks
SET heartbeat_at = started_at
WHERE status = 'running' AND heartbeat_at IS NULL;
