ALTER TABLE ai_profile_versions ADD COLUMN deleted_at TEXT;
ALTER TABLE system_config_versions ADD COLUMN deleted_at TEXT;

CREATE INDEX ai_profile_versions_visible_idx
  ON ai_profile_versions (profile, version DESC) WHERE deleted_at IS NULL;

CREATE INDEX system_config_versions_visible_idx
  ON system_config_versions (config_key, version DESC) WHERE deleted_at IS NULL;
