-- Add `processing_notes` to public.form_submission.
--
-- The form processor (api/forms/process-application.js) silently swallowed
-- per-field upsert errors during the post-submit member/org write loop.
-- See task: fix-form-custom-fields-not-saving — submission
-- 35cd83a2-af40-4840-b518-bb7395d174dd dropped two custom fields with no
-- visible signal (a parent-watermark trigger was failing every
-- member_preference_value insert).
--
-- This column is the structured breadcrumb the processor now writes when
-- any per-field upsert fails (or is skipped because no target could be
-- resolved), so the FormSubmissionView admin page can surface dropped
-- fields. Shape: a JSON array of { kind, message, ...context } entries.
--
-- Nullable because the overwhelming majority of submissions process
-- cleanly; only failures populate it.

ALTER TABLE public.form_submission
  ADD COLUMN IF NOT EXISTS processing_notes JSONB;

COMMENT ON COLUMN public.form_submission.processing_notes IS
  'Structured per-submission processing diagnostics written by api/forms/process-application.js when one or more mapped fields could not be saved. Shape: JSON array of {kind, message, member_id?, organization_id?, field_id?, field_label?, field_type?, entity_scope?, error?} entries. Null when processing was clean.';

NOTIFY pgrst, 'reload schema';
