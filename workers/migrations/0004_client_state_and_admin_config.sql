ALTER TABLE thinking_sessions ADD COLUMN article_content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE thinking_sessions ADD COLUMN stage TEXT NOT NULL DEFAULT 'summary';
ALTER TABLE thinking_sessions ADD COLUMN completed_rounds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thinking_sessions ADD COLUMN coverage_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE thinking_sessions ADD COLUMN coach_state_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE thinking_sessions ADD COLUMN report_json TEXT;
ALTER TABLE thinking_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE thinking_sessions ADD COLUMN updated_at TEXT;

CREATE INDEX thinking_sessions_article_idx ON thinking_sessions (owner_id, article_id, created_at DESC);

INSERT INTO preferences (owner_id, locale, target_locale, settings_json, updated_at)
VALUES ('owner', 'zh-CN', 'zh-CN', '{"languageMode":"system","themeMode":"system","fontSize":17,"lineHeightRatio":1.7,"version":1}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(owner_id) DO NOTHING;
