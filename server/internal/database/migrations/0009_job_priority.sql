ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS jobs_claim;
CREATE INDEX jobs_claim ON jobs(status, priority DESC, run_at, lease_until);
