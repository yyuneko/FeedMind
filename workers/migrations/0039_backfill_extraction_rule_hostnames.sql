ALTER TABLE feed_extraction_rules ADD COLUMN hostname TEXT;

WITH source_urls AS (
  SELECT rule.id AS rule_id, article.canonical_url AS url, 1 AS article_weight
  FROM feed_extraction_rules rule
  JOIN articles article ON article.feed_id = rule.feed_id
  WHERE article.canonical_url LIKE 'http://%' OR article.canonical_url LIKE 'https://%'
  UNION ALL
  SELECT rule.id AS rule_id, feed.url AS url, 0 AS article_weight
  FROM feed_extraction_rules rule
  JOIN feeds feed ON feed.id = rule.feed_id
  WHERE feed.url LIKE 'http://%' OR feed.url LIKE 'https://%'
), url_tails AS (
  SELECT rule_id, article_weight, substr(url, instr(url, '://') + 3) AS tail
  FROM source_urls
), authorities AS (
  SELECT rule_id, article_weight, substr(tail, 1, instr(tail || '/', '/') - 1) AS authority
  FROM url_tails
), queryless_authorities AS (
  SELECT rule_id, article_weight, substr(authority, 1, instr(authority || '?', '?') - 1) AS authority
  FROM authorities
), fragmentless_authorities AS (
  SELECT rule_id, article_weight, substr(authority, 1, instr(authority || '#', '#') - 1) AS authority
  FROM queryless_authorities
), hosts AS (
  SELECT rule_id, article_weight,
    lower(CASE WHEN instr(authority, ':') > 0 THEN substr(authority, 1, instr(authority, ':') - 1) ELSE authority END) AS hostname
  FROM fragmentless_authorities
), ranked_hosts AS (
  SELECT rule_id, hostname,
    row_number() OVER (
      PARTITION BY rule_id
      ORDER BY sum(article_weight) DESC, max(article_weight) DESC, hostname
    ) AS rank
  FROM hosts
  WHERE hostname <> ''
  GROUP BY rule_id, hostname
)
UPDATE feed_extraction_rules
SET hostname = (SELECT ranked.hostname FROM ranked_hosts ranked
  WHERE ranked.rule_id = feed_extraction_rules.id AND ranked.rank = 1)
WHERE (hostname IS NULL OR trim(hostname) = '')
  AND EXISTS (SELECT 1 FROM ranked_hosts ranked
    WHERE ranked.rule_id = feed_extraction_rules.id AND ranked.rank = 1);
