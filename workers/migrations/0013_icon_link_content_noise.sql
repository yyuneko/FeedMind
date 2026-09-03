UPDATE system_config_versions
SET status = 'archived'
WHERE config_key = 'content_deduplication' AND status = 'active';

INSERT INTO system_config_versions
  (id, config_key, version, status, value_json, created_by_subject, created_by_email, created_at)
VALUES
  ('b4417594-8ab2-445c-a538-48ecbc0a5130', 'content_deduplication', 2, 'active',
   '{"algorithmVersion":"feed-block-minhash-v2","historyWindowArticles":12,"minimumFeedArticles":5,"exactMinimumArticles":3,"exactMinimumRatio":0.6,"similarMinimumArticles":4,"similarMinimumRatio":0.7,"similarityMinimumMatches":29,"minimumLength":12,"maximumLength":2000,"similarMinimumLength":80,"positionTolerance":0.15,"positionConsistency":0.8}',
   'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- v2 changes stable block ordering by grouping icon-only controls. Clear only
-- derived manifests; immutable R2 source objects remain intact and the scheduler re-analyzes each current article version.
UPDATE articles
SET noise_manifest_json = '[]', noise_manifest_hash = NULL, noise_analyzed_at = NULL;
