-- Add an `owners` column to form.
--
-- Lets form admins assign one or more members as "Owners" of a form (configured
-- from the FormBuilder → Form Settings "Owners" card). Owners get a dedicated
-- "My Forms" tab on the FormSubmissions page that is scoped to the forms they
-- own. Stored as an array of member UUIDs; no per-element FK is possible on an
-- array column, so referential integrity is handled in application code.
-- Defaults to an empty array so existing forms have no owners. Idempotent.

ALTER TABLE form
  ADD COLUMN IF NOT EXISTS owners UUID[] NOT NULL DEFAULT '{}';
