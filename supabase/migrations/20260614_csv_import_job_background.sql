-- Task #1362 Phase 2: server-side background import jobs.
-- Extend csv_import_job with everything the headless cron worker needs to
-- process an import without the browser in the loop: a stored file reference,
-- a resumable cursor, running totals, worker auth/locking, and lifecycle
-- timestamps. Idempotent.

-- Worker dispatch auth (mirrors form_submission_export_job.worker_token).
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS worker_token uuid NOT NULL DEFAULT gen_random_uuid();

-- Lock/stale detection: the worker stamps this each step; the cron backstop
-- only revives jobs whose heartbeat is older than its stale window.
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

-- Lifecycle timestamps.
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Resumable cursor (next unprocessed row index) carried by the worker across
-- invocations, plus the pinned path choice ('js' once the SQL fast path has
-- fallen back so later slices stay on the JS path).
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS cursor_offset integer NOT NULL DEFAULT 0;
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS force_path text;

-- Stored file reference (tenant-scoped Supabase storage object) the worker
-- downloads + re-parses each slice.
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS storage_bucket text;
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS storage_path text;

-- Recorded as the note author for any imported notes (the enqueuing member).
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS requested_by_member_id uuid;

-- Extra running totals not already present (created_count / updated_count /
-- error_count were added by the history migration).
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS skipped_count integer NOT NULL DEFAULT 0;
ALTER TABLE csv_import_job ADD COLUMN IF NOT EXISTS notes_created integer NOT NULL DEFAULT 0;

-- Status filter index for the cron worker's "queued / stale processing" scan.
CREATE INDEX IF NOT EXISTS idx_csv_import_job_status_created
  ON csv_import_job (status, created_at);
