ALTER TABLE articles ADD COLUMN IF NOT EXISTS thumbnail_url text;

UPDATE articles
SET thumbnail_url = NULLIF((regexp_match(content_html, '<img[^>]+src=["''](https?://[^"'']+)["'']', 'i'))[1], '')
WHERE thumbnail_url IS NULL AND content_html <> '';
