PRAGMA foreign_keys = ON;

CREATE TABLE library_categories (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX library_categories_owner_name_idx
  ON library_categories(owner_id, name COLLATE NOCASE);
CREATE INDEX library_categories_owner_sort_idx
  ON library_categories(owner_id, sort_order, name COLLATE NOCASE);

ALTER TABLE sources ADD COLUMN custom_title TEXT;
ALTER TABLE sources ADD COLUMN library_category_id TEXT REFERENCES library_categories(id) ON DELETE SET NULL;
ALTER TABLE sources ADD COLUMN library_sort_order INTEGER NOT NULL DEFAULT 0 CHECK (library_sort_order >= 0);

ALTER TABLE article_states ADD COLUMN last_opened_at TEXT;

CREATE INDEX sources_library_category_idx
  ON sources(owner_id, library_category_id, library_sort_order, title COLLATE NOCASE);
CREATE INDEX article_states_recent_idx
  ON article_states(owner_id, last_opened_at DESC)
  WHERE last_opened_at IS NOT NULL;

INSERT INTO library_categories (id, owner_id, name, sort_order, created_at, updated_at)
SELECT 'category:' || lower(hex(randomblob(16))), owner_id, MIN(name),
       ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY lower(name)) - 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT owner_id, trim(category) AS name
  FROM subscriptions
  WHERE NULLIF(trim(category), '') IS NOT NULL
  UNION ALL
  SELECT s.owner_id, trim(c.name) AS name
  FROM source_categories c JOIN sources s ON s.id = c.source_id
  WHERE NULLIF(trim(c.name), '') IS NOT NULL
)
GROUP BY owner_id, lower(name);

UPDATE sources
SET custom_title = (
      SELECT NULLIF(trim(sub.custom_title), '')
      FROM subscriptions sub
      WHERE sub.owner_id = sources.owner_id AND sub.feed_id = sources.legacy_feed_id
      LIMIT 1
    ),
    library_sort_order = COALESCE((
      SELECT sub.sort_order FROM subscriptions sub
      WHERE sub.owner_id = sources.owner_id AND sub.feed_id = sources.legacy_feed_id
      LIMIT 1
    ), 0),
    library_category_id = (
      SELECT category.id
      FROM library_categories category
      WHERE category.owner_id = sources.owner_id
        AND lower(category.name) = lower(COALESCE(
          (SELECT NULLIF(trim(sub.category), '') FROM subscriptions sub
           WHERE sub.owner_id = sources.owner_id AND sub.feed_id = sources.legacy_feed_id LIMIT 1),
          (SELECT NULLIF(trim(sc.name), '') FROM source_categories sc
           WHERE sc.source_id = sources.id ORDER BY sc.sort_order, lower(sc.name) LIMIT 1)
        ))
      LIMIT 1
    );
