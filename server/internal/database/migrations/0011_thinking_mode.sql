CREATE TABLE IF NOT EXISTS thinking_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  article_content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','abandoned')),
  stage text NOT NULL DEFAULT 'summary',
  completed_rounds int NOT NULL DEFAULT 0 CHECK(completed_rounds BETWEEN 0 AND 5),
  coverage jsonb NOT NULL DEFAULT '{}',
  coach_state jsonb NOT NULL DEFAULT '{}',
  report jsonb,
  version bigint NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS thinking_sessions_one_active
  ON thinking_sessions(user_id, article_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS thinking_sessions_article_history
  ON thinking_sessions(user_id, article_id, started_at DESC);

CREATE TABLE IF NOT EXISTS thinking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES thinking_sessions(id) ON DELETE CASCADE,
  sequence int NOT NULL CHECK(sequence > 0),
  kind text NOT NULL CHECK(kind IN ('question','answer','feedback','hint','explanation')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  operation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, sequence),
  UNIQUE(session_id, operation_id)
);

