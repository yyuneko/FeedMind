CREATE TABLE article_image_translations (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  image_id TEXT NOT NULL,
  image_url TEXT NOT NULL,
  target_locale TEXT NOT NULL CHECK (target_locale IN ('zh-CN', 'en-US', 'ja-JP')),
  reference_width INTEGER NOT NULL CHECK (reference_width > 0 AND reference_width <= 20000),
  reference_height INTEGER NOT NULL CHECK (reference_height > 0 AND reference_height <= 20000),
  segments_json TEXT NOT NULL CHECK (json_valid(segments_json)),
  created_by TEXT NOT NULL DEFAULT 'mcp',
  idempotency_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, article_id, source_hash, image_id, target_locale)
);

CREATE INDEX article_image_translations_current_idx
ON article_image_translations(owner_id, article_id, source_hash, target_locale);
