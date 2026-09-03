ALTER TABLE article_classifications ADD COLUMN source_title_locale TEXT
  CHECK (source_title_locale IS NULL OR source_title_locale IN ('zh-CN', 'en-US', 'ja-JP', 'other'));

