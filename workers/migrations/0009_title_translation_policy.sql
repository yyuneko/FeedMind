ALTER TABLE article_classifications
ADD COLUMN title_translation_policy_version INTEGER NOT NULL DEFAULT 1
CHECK (title_translation_policy_version >= 1);
