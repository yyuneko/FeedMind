-- GPT Actions may supply a translated title or summary without invoking FeedMind's AI workflow.
CREATE TABLE article_gpt_localizations (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  target_locale TEXT NOT NULL CHECK (target_locale IN ('zh-CN', 'en-US', 'ja-JP')),
  source_hash TEXT NOT NULL,
  translated_title TEXT,
  one_line_summary TEXT,
  created_by TEXT NOT NULL DEFAULT 'gpt_action',
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, article_id, target_locale),
  CHECK (translated_title IS NOT NULL OR one_line_summary IS NOT NULL)
);

CREATE INDEX article_gpt_localizations_article_idx
ON article_gpt_localizations(article_id, target_locale, source_hash);
