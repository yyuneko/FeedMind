ALTER TABLE subscriptions ADD COLUMN custom_title TEXT;
ALTER TABLE subscriptions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0);

ALTER TABLE articles ADD COLUMN thumbnail_url TEXT;
ALTER TABLE articles ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1 CHECK (parser_version > 0);
ALTER TABLE articles ADD COLUMN parse_error TEXT;

CREATE TABLE article_state_operations (
  owner_id TEXT NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  operation_id TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, operation_id)
);

CREATE INDEX subscriptions_owner_sort_idx
  ON subscriptions (owner_id, sort_order, created_at);
