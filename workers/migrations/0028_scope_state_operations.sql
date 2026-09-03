PRAGMA foreign_keys = ON;

ALTER TABLE article_state_operations RENAME TO article_state_operations_legacy_0028;

CREATE TABLE article_state_operations (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, connection_id, operation_id)
);

INSERT INTO article_state_operations(owner_id, connection_id, operation_id, article_id, created_at)
SELECT owner_id, COALESCE(connection_id, 'connection:direct-rss:' || owner_id), operation_id, article_id, created_at
FROM article_state_operations_legacy_0028
WHERE EXISTS (SELECT 1 FROM source_connections connection
  WHERE connection.id = COALESCE(article_state_operations_legacy_0028.connection_id,
    'connection:direct-rss:' || article_state_operations_legacy_0028.owner_id));

DROP TABLE article_state_operations_legacy_0028;

CREATE INDEX article_state_operations_article_idx
  ON article_state_operations(owner_id, connection_id, article_id, created_at DESC);
