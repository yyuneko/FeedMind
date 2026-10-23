ALTER TABLE feed_extraction_rules ADD COLUMN name TEXT;
ALTER TABLE feed_extraction_rules ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (is_enabled IN (0, 1));
ALTER TABLE platform_extraction_rules ADD COLUMN change_note TEXT;

UPDATE feed_extraction_rules
SET name = COALESCE(
  (SELECT NULLIF(feed.title, '') FROM feeds feed WHERE feed.id = feed_extraction_rules.feed_id),
  (SELECT feed.url FROM feeds feed WHERE feed.id = feed_extraction_rules.feed_id)
)
WHERE name IS NULL OR trim(name) = '';
