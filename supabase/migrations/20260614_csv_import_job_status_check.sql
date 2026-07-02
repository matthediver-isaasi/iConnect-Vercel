-- Widen the csv_import_job status check constraint to cover the full
-- background-import lifecycle. The original constraint only allowed
-- 'pending'/'processing'/'completed'/'failed', so enqueue (which inserts
-- 'initializing'/'queued'), the worker ('running'), error finalisation
-- ('completed_with_errors') and cancellation ('cancelled') all violated it.
-- Idempotent.
ALTER TABLE csv_import_job DROP CONSTRAINT IF EXISTS csv_import_job_status_check;
ALTER TABLE csv_import_job ADD CONSTRAINT csv_import_job_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'initializing'::text,
    'queued'::text,
    'running'::text,
    'processing'::text,
    'completed'::text,
    'completed_with_errors'::text,
    'failed'::text,
    'cancelled'::text
  ]));
