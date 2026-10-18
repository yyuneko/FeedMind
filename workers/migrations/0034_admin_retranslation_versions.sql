-- Explicit admin retranslations create a new version even when configuration is unchanged.
-- Ordinary requests remain idempotent; translations_one_active_idx still prevents concurrent jobs.
DROP INDEX translations_version_idempotency_idx;

CREATE UNIQUE INDEX translations_version_idempotency_idx ON translations (
  article_id, target_locale, source_hash, article_type,
  prompt_version_id, title_profile_version_id, body_profile_version_id
)
WHERE trigger_reason <> 'admin_retranslate';
