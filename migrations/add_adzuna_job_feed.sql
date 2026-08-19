-- Tenant-specific Adzuna feed configuration and external-job provenance.
CREATE TABLE IF NOT EXISTS tenant_job_feed_config (
  tenant_id UUID PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL DEFAULT 'adzuna' CHECK (provider = 'adzuna'),
  keywords TEXT NOT NULL DEFAULT '',
  exclusions TEXT NOT NULL DEFAULT '',
  category VARCHAR(100),
  location VARCHAR(255),
  max_days_old INTEGER NOT NULL DEFAULT 30 CHECK (max_days_old BETWEEN 1 AND 90),
  result_limit INTEGER NOT NULL DEFAULT 25 CHECK (result_limit BETWEEN 1 AND 50),
  last_sync_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  last_imported_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE job_posting ADD COLUMN IF NOT EXISTS external_source VARCHAR(30);
ALTER TABLE job_posting ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);
ALTER TABLE job_posting ADD COLUMN IF NOT EXISTS external_url TEXT;
ALTER TABLE job_posting ADD COLUMN IF NOT EXISTS source_attribution VARCHAR(100);
ALTER TABLE job_posting ADD COLUMN IF NOT EXISTS external_last_seen_at TIMESTAMPTZ;
-- Adzuna does not provide an application deadline. Native posting forms still
-- require this field via schema/JobPosting.json; imported rows may safely omit it.
ALTER TABLE job_posting ALTER COLUMN closing_date DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS job_posting_external_source_id_unique
  ON job_posting (tenant_id, external_source, external_id);
CREATE INDEX IF NOT EXISTS job_posting_adzuna_active_idx
  ON job_posting (tenant_id, external_source, status);

CREATE TABLE IF NOT EXISTS job_feed_sync_cursor (
  provider VARCHAR(30) PRIMARY KEY,
  last_tenant_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);