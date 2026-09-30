-- Add optional scheduled-deactivation fields to form.
--
-- Lets admins schedule a form to automatically stop accepting submissions at a
-- specific date/time. `deactivate_at` is stored as a UTC timestamp;
-- `deactivate_timezone` records the IANA timezone the admin picked so the
-- FormBuilder UI can re-display the wall-clock time consistently. Both are
-- nullable: when `deactivate_at` is NULL the form stays active until the
-- existing `is_active` toggle is turned off. Idempotent.

ALTER TABLE form
  ADD COLUMN IF NOT EXISTS deactivate_at TIMESTAMPTZ;

ALTER TABLE form
  ADD COLUMN IF NOT EXISTS deactivate_timezone TEXT;
