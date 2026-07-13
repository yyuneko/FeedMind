INSERT INTO jobs(type, idempotency_key, payload)
SELECT 'parse_article', id::text || ':v4', jsonb_build_object('articleId', id)
FROM articles
WHERE parser_version < 4
ON CONFLICT DO NOTHING;
