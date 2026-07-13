ALTER TABLE articles
  DROP COLUMN IF EXISTS rss_summary,
  DROP COLUMN IF EXISTS rss_content;

INSERT INTO jobs(type, idempotency_key, payload)
SELECT 'parse_article', id::text || ':v8', jsonb_build_object('articleId', id)
FROM articles
ON CONFLICT DO NOTHING;
