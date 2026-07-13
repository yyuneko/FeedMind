UPDATE articles
SET parse_status = 'pending', parse_error = NULL, updated_at = now()
WHERE parser_version < 7;

INSERT INTO jobs(type, idempotency_key, payload)
SELECT 'parse_article', id::text || ':v7', jsonb_build_object('articleId', id)
FROM articles
WHERE parser_version < 7
ON CONFLICT DO NOTHING;
