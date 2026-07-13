INSERT INTO jobs(type, idempotency_key, payload)
SELECT 'parse_article', id::text || ':v6', jsonb_build_object('articleId', id)
FROM articles
WHERE parser_version < 6
ON CONFLICT DO NOTHING;
