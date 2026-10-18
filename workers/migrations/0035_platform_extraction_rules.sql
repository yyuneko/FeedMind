-- Public publishing platforms are extraction configuration only. They are not
-- feeds or subscriptions and therefore never participate in scheduled fetching.
CREATE TABLE platform_extraction_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  include_subdomains INTEGER NOT NULL DEFAULT 0 CHECK (include_subdomains IN (0, 1)),
  rule_json TEXT NOT NULL CHECK (json_valid(rule_json)),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_by_subject TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX platform_extraction_rules_enabled_hostname_idx
  ON platform_extraction_rules (is_enabled, hostname);
