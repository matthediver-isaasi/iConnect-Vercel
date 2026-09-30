-- Task #944: Allow public form submitters to email themselves a Word (DOCX) copy
-- of their submission. Admins opt in per form from the Form Builder Settings tab.
-- When this flag is true, FormView renders an email input + checkbox at the bottom
-- of the form; on successful submission the server emails the submitter a DOCX
-- copy of their submission via the existing Mailgun-based email service.

BEGIN;

ALTER TABLE form
  ADD COLUMN IF NOT EXISTS allow_submitter_email_copy boolean NOT NULL DEFAULT false;

COMMIT;
