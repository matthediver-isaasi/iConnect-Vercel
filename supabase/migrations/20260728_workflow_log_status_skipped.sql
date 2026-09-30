-- Task 3196: allow workflow_log.status = 'skipped' so the workflow engine can
-- record runs whose trigger matched but whose conditions evaluated false
-- (with per-condition expected vs actual in trigger_data.condition_results).
-- Idempotent: drops and recreates the check constraint.
ALTER TABLE workflow_log DROP CONSTRAINT IF EXISTS workflow_log_status_check;
ALTER TABLE workflow_log ADD CONSTRAINT workflow_log_status_check
  CHECK (status IN ('success', 'partial', 'failed', 'skipped'));
