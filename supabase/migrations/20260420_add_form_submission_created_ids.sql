-- Migration: Add created_member_id and created_organization_id columns to form_submission
--
-- Purpose:
-- - The application distinguishes the member/org the submission was submitted *as*
--   (member_id / organization_id) from the member/org *created or resolved by
--   processing* the submission (created_member_id / created_organization_id).
-- - These columns are read and written by api/forms/process-application.js,
--   api/forms/send-submission-email.js, api/public/form-submission.js and the
--   matching frontend code, but no DDL existed for them — production logs were
--   surfacing `column form_submission.created_member_id does not exist`.
--
-- Safe to re-run on any environment.

ALTER TABLE form_submission
ADD COLUMN IF NOT EXISTS created_member_id UUID REFERENCES member(id);

ALTER TABLE form_submission
ADD COLUMN IF NOT EXISTS created_organization_id UUID REFERENCES organization(id);

CREATE INDEX IF NOT EXISTS idx_form_submission_created_member_id
ON form_submission(created_member_id)
WHERE created_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_form_submission_created_organization_id
ON form_submission(created_organization_id)
WHERE created_organization_id IS NOT NULL;
