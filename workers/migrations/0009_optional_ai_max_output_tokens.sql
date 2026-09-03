ALTER TABLE ai_profile_versions RENAME COLUMN max_output_tokens TO max_output_tokens_required;

ALTER TABLE ai_profile_versions
  ADD COLUMN max_output_tokens INTEGER CHECK (max_output_tokens > 0);

UPDATE ai_profile_versions
SET max_output_tokens = max_output_tokens_required;

ALTER TABLE ai_profile_versions DROP COLUMN max_output_tokens_required;
