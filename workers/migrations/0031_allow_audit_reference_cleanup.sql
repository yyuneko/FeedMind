PRAGMA foreign_keys = ON;

-- ai_usage_events is immutable, but its three nullable parent references use
-- ON DELETE SET NULL. Permit only those references to be cleared by SQLite's
-- foreign-key actions while keeping every recorded usage value immutable.
DROP TRIGGER IF EXISTS ai_usage_events_no_update;

CREATE TRIGGER ai_usage_events_no_update
BEFORE UPDATE ON ai_usage_events
WHEN NOT (
  NEW.id IS OLD.id
  AND NEW.purpose IS OLD.purpose
  AND NEW.profile_version_id IS OLD.profile_version_id
  AND NEW.provider IS OLD.provider
  AND NEW.model IS OLD.model
  AND NEW.status IS OLD.status
  AND (NEW.article_id IS OLD.article_id OR NEW.article_id IS NULL)
  AND (NEW.translation_id IS OLD.translation_id OR NEW.translation_id IS NULL)
  AND (NEW.preprocessing_run_id IS OLD.preprocessing_run_id OR NEW.preprocessing_run_id IS NULL)
  AND NEW.input_tokens IS OLD.input_tokens
  AND NEW.output_tokens IS OLD.output_tokens
  AND NEW.thinking_tokens IS OLD.thinking_tokens
  AND NEW.latency_ms IS OLD.latency_ms
  AND NEW.error_code IS OLD.error_code
  AND NEW.request_id IS OLD.request_id
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'ai usage events are immutable');
END;
