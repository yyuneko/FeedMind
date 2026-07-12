INSERT INTO jobs(type, idempotency_key, payload)
SELECT 'parse_article', id::text, jsonb_build_object('articleId', id)
FROM articles
WHERE parser_version < 2
ON CONFLICT DO NOTHING;
