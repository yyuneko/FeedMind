PRAGMA foreign_keys = ON;

-- Single articles are stored under the virtual "自选" feed. Older C API
-- versions did not mirror that feed and its articles into the generic source
-- tables used by the current library navigation UI.
INSERT OR IGNORE INTO sources
  (id, owner_id, connection_id, external_id, kind, title, url, enabled, sync_status,
   legacy_feed_id, metadata_json, created_at, updated_at)
SELECT f.id, f.owner_id, 'connection:direct-rss:' || f.owner_id,
       'feedmind://selected/owner', 'feed', '自选', 'feedmind://selected/owner',
       1, 'ok', f.id, '{"system":"selected"}', f.created_at, f.updated_at
FROM feeds f
JOIN subscriptions subscription ON subscription.feed_id = f.id AND subscription.owner_id = f.owner_id
JOIN source_connections connection
  ON connection.id = 'connection:direct-rss:' || f.owner_id AND connection.owner_id = f.owner_id
WHERE f.url = 'feedmind://selected/owner' AND subscription.is_active = 1;

UPDATE sources
SET title = '自选', enabled = 1, sync_status = 'ok', metadata_json = '{"system":"selected"}'
WHERE external_id = 'feedmind://selected/owner'
  AND connection_id LIKE 'connection:direct-rss:%';

INSERT OR IGNORE INTO source_items
  (id, owner_id, connection_id, source_id, external_item_id, article_id, canonical_url,
   metadata_json, first_seen_at, last_seen_at)
SELECT 'selected:' || article.id, article.owner_id,
       'connection:direct-rss:' || article.owner_id, source.id, article.id, article.id,
       article.canonical_url, '{}', article.created_at, article.updated_at
FROM articles article
JOIN feeds feed ON feed.id = article.feed_id AND feed.owner_id = article.owner_id
JOIN sources source ON source.legacy_feed_id = feed.id AND source.owner_id = article.owner_id
WHERE feed.url = 'feedmind://selected/owner';
