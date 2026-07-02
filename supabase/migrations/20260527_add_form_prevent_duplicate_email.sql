-- Add `prevent_duplicate_email_submission` boolean to form.
--
-- When true, the public form submission endpoint rejects any submission
-- whose extracted submitter email matches an email already used on a
-- prior submission of the same form (case-insensitive, whitespace-trimmed).
--
-- Default false preserves existing behaviour (unlimited resubmissions).
--
-- Safe to re-run on any environment.

BEGIN;

ALTER TABLE form
  ADD COLUMN IF NOT EXISTS prevent_duplicate_email_submission boolean NOT NULL DEFAULT false;

COMMIT;

NOTIFY pgrst, 'reload schema';
