-- Make csv_import_job usable for the Import Manager "Recent Imports" panel and
-- the "reuse setup" feature. Idempotent.

-- Tenant scoping so each tenant only sees its own import history.
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS tenant_id uuid;
CREATE INDEX IF NOT EXISTS idx_csv_import_job_tenant_created
  ON csv_import_job (tenant_id, created_at DESC);

-- Separate created/updated counts so the panel can show the created-vs-updated split.
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS created_count integer NOT NULL DEFAULT 0;
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS updated_count integer NOT NULL DEFAULT 0;

-- The identifier column used to match records, stored so a saved setup can be reused.
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS identifier_field text;
