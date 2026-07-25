-- Prevent duplicate public form submissions.
-- Adds a client-supplied idempotency key to form_submission. The public
-- submission endpoint short-circuits when a row with the same
-- (form_id, idempotency_key) already exists, and the unique partial index
-- makes the guard race-proof: two truly concurrent requests with the same
-- key cannot both insert (the loser gets a unique violation and returns the
-- winner's row).
-- Idempotent.

ALTER TABLE form_submission
  ADD COLUMN IF NOT EXISTS idempotency_key text;

COMMENT ON COLUMN form_submission.idempotency_key IS
  'Client-generated once-per-form-fill key; unique per form. NULL for legacy/admin/non-browser submissions.';

CREATE UNIQUE INDEX IF NOT EXISTS form_submission_form_idempotency_key_uidx
  ON form_submission (form_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
