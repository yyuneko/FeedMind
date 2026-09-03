-- Cover the high-frequency ownership and selected-source lookups used by
-- article detail, translation status, reading state, and library navigation.
CREATE INDEX source_items_owner_article_connection_idx
  ON source_items(owner_id, article_id, connection_id, source_id);

CREATE INDEX source_items_owner_connection_source_article_idx
  ON source_items(owner_id, connection_id, source_id, article_id);

-- Article detail repeatedly resolves the current classification and latest
-- preprocessing task by article without scanning unrelated history.
CREATE INDEX article_classifications_article_source_created_idx
  ON article_classifications(article_id, source_hash, created_at DESC);

CREATE INDEX article_preprocessing_tasks_article_created_idx
  ON article_preprocessing_tasks(article_id, created_at DESC);

-- Translation reads are scoped by owner, article, locale, and recency.
CREATE INDEX translations_owner_article_locale_created_idx
  ON translations(owner_id, article_id, target_locale, created_at DESC);
