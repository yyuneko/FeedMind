CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, password_hash text NOT NULL,
  email_verified_at timestamptz, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));
CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash bytea NOT NULL UNIQUE, device_name text NOT NULL DEFAULT '', expires_at timestamptz NOT NULL,
  revoked_at timestamptz, last_rotated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK(purpose IN ('verify','reset')), token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), url text NOT NULL, normalized_url text NOT NULL UNIQUE,
  title text NOT NULL DEFAULT '', site_url text, icon_url text, description text,
  fetch_status text NOT NULL DEFAULT 'pending', etag text, last_modified text, last_attempt_at timestamptz,
  last_success_at timestamptz, last_failure_at timestamptz, last_error text, failure_count int NOT NULL DEFAULT 0,
  next_fetch_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_feed_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id uuid NOT NULL REFERENCES feeds(id) ON DELETE RESTRICT, custom_name text, category text NOT NULL DEFAULT '',
  sort_order int NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,feed_id)
);
CREATE TABLE IF NOT EXISTS articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), feed_id uuid NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid text, source_url text, canonical_url text, identity_hash text NOT NULL,
  title text NOT NULL, author text, published_at timestamptz, rss_summary text NOT NULL DEFAULT '', rss_content text NOT NULL DEFAULT '',
  content_html text NOT NULL DEFAULT '', content_text text NOT NULL DEFAULT '', content_hash text NOT NULL DEFAULT '',
  parse_status text NOT NULL DEFAULT 'pending', parser_version int NOT NULL DEFAULT 1, parse_error text, parsed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(feed_id, identity_hash)
);
CREATE INDEX IF NOT EXISTS articles_feed_published ON articles(feed_id,published_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS user_article_states (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  is_read boolean NOT NULL DEFAULT false, is_starred boolean NOT NULL DEFAULT false, progress real NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 1),
  last_read_at timestamptz, version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,article_id)
);
CREATE TABLE IF NOT EXISTS prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legacy_client_id text, name text NOT NULL, content text NOT NULL, content_version bigint NOT NULL DEFAULT 1,
  content_hash text NOT NULL, is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,legacy_client_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS prompts_one_default ON prompts(user_id) WHERE is_default;
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, language_mode text NOT NULL DEFAULT 'system',
  theme_mode text NOT NULL DEFAULT 'system', font_size int NOT NULL DEFAULT 17 CHECK(font_size BETWEEN 14 AND 24),
  line_height real NOT NULL DEFAULT 1.65 CHECK(line_height BETWEEN 1.35 AND 2), version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'queued', attempts int NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_unique ON jobs(type,idempotency_key) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status,run_at,lease_until);
CREATE TABLE IF NOT EXISTS data_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL, version int NOT NULL, batch_key text NOT NULL, status text NOT NULL,
  stats jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,device_id,version,batch_key)
);
