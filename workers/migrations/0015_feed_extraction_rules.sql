ALTER TABLE articles ADD COLUMN extraction_rule_version_id TEXT;
ALTER TABLE articles ADD COLUMN extraction_strategy TEXT NOT NULL DEFAULT 'readability'
  CHECK (extraction_strategy IN ('site_rule', 'readability', 'readability_fallback'));
ALTER TABLE articles ADD COLUMN extraction_diagnostic_code TEXT;

CREATE TABLE feed_extraction_rules (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL UNIQUE REFERENCES feeds(id) ON DELETE CASCADE,
  draft_version_id TEXT,
  active_version_id TEXT,
  created_by_subject TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE feed_extraction_rule_versions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES feed_extraction_rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  rule_json TEXT NOT NULL CHECK (json_valid(rule_json)),
  config_hash TEXT NOT NULL,
  change_note TEXT,
  created_by_subject TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (rule_id, version)
);

CREATE UNIQUE INDEX feed_extraction_rule_versions_one_draft_idx
  ON feed_extraction_rule_versions (rule_id) WHERE status = 'draft';
CREATE UNIQUE INDEX feed_extraction_rule_versions_one_active_idx
  ON feed_extraction_rule_versions (rule_id) WHERE status = 'active';

CREATE TABLE feed_extraction_rule_validations (
  id TEXT PRIMARY KEY,
  rule_version_id TEXT NOT NULL REFERENCES feed_extraction_rule_versions(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  config_hash TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  confirmed_by_subject TEXT NOT NULL,
  confirmed_by_email TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  UNIQUE (rule_version_id, article_id)
);

CREATE INDEX feed_extraction_rule_validations_version_idx
  ON feed_extraction_rule_validations (rule_version_id, confirmed_at DESC);

CREATE TABLE article_source_block_alignments (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  from_source_hash TEXT NOT NULL,
  to_source_hash TEXT NOT NULL,
  mapping_json TEXT NOT NULL CHECK (json_valid(mapping_json)),
  current_coverage REAL NOT NULL CHECK (current_coverage >= 0 AND current_coverage <= 1),
  is_ambiguous INTEGER NOT NULL CHECK (is_ambiguous IN (0, 1)),
  algorithm_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (article_id, from_source_hash, to_source_hash)
);
