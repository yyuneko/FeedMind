ALTER TABLE articles ADD COLUMN noise_manifest_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(noise_manifest_json));
ALTER TABLE articles ADD COLUMN noise_manifest_hash TEXT;
ALTER TABLE articles ADD COLUMN noise_analyzed_at TEXT;

ALTER TABLE translations ADD COLUMN noise_manifest_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(noise_manifest_json));
ALTER TABLE translations ADD COLUMN noise_manifest_hash TEXT;

CREATE TABLE article_content_blocks (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  stable_id TEXT NOT NULL,
  block_index INTEGER NOT NULL CHECK (block_index >= 0),
  block_kind TEXT NOT NULL,
  relative_position REAL NOT NULL CHECK (relative_position >= 0 AND relative_position <= 1),
  normalized_length INTEGER NOT NULL CHECK (normalized_length >= 0),
  exact_fingerprint TEXT NOT NULL,
  similarity_sketch_json TEXT NOT NULL CHECK (json_valid(similarity_sketch_json)),
  is_protected INTEGER NOT NULL CHECK (is_protected IN (0, 1)),
  is_eligible INTEGER NOT NULL CHECK (is_eligible IN (0, 1)),
  noise_pattern_id TEXT,
  decision_kind TEXT CHECK (decision_kind IS NULL OR decision_kind IN ('exact', 'similar')),
  support_count INTEGER,
  window_article_count INTEGER,
  frequency REAL,
  position_consistency REAL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  marked_at TEXT,
  UNIQUE (article_id, source_hash, stable_id)
);

CREATE INDEX article_content_blocks_feed_source_idx
  ON article_content_blocks (feed_id, source_hash, article_id);
CREATE INDEX article_content_blocks_exact_idx
  ON article_content_blocks (feed_id, exact_fingerprint) WHERE is_eligible = 1;
CREATE INDEX article_content_blocks_noise_idx
  ON article_content_blocks (article_id, source_hash) WHERE noise_pattern_id IS NOT NULL;

CREATE TABLE feed_noise_patterns (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  representative_fingerprint TEXT NOT NULL,
  representative_sketch_json TEXT NOT NULL CHECK (json_valid(representative_sketch_json)),
  match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'similar')),
  support_count INTEGER NOT NULL CHECK (support_count > 0),
  window_article_count INTEGER NOT NULL CHECK (window_article_count > 0),
  frequency REAL NOT NULL CHECK (frequency >= 0 AND frequency <= 1),
  position_consistency REAL NOT NULL CHECK (position_consistency >= 0 AND position_consistency <= 1),
  policy_version TEXT NOT NULL,
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  UNIQUE (feed_id, representative_fingerprint, match_kind, policy_version)
);

CREATE INDEX feed_noise_patterns_feed_idx ON feed_noise_patterns (feed_id, last_detected_at DESC);

INSERT INTO system_config_versions
  (id, config_key, version, status, value_json, created_by_subject, created_by_email, created_at)
VALUES
  ('6b38b44b-7d55-4fd2-91a1-15d5f21df337', 'content_deduplication', 1, 'active',
   '{"algorithmVersion":"feed-block-minhash-v1","historyWindowArticles":12,"minimumFeedArticles":5,"exactMinimumArticles":3,"exactMinimumRatio":0.6,"similarMinimumArticles":4,"similarMinimumRatio":0.7,"similarityMinimumMatches":29,"minimumLength":12,"maximumLength":2000,"similarMinimumLength":80,"positionTolerance":0.15,"positionConsistency":0.8}',
   'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
