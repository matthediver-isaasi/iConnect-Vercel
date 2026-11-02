BEGIN;
ALTER TABLE public.form
  ADD COLUMN IF NOT EXISTS submitter_copy_email_message text;
COMMENT ON COLUMN public.form.submitter_copy_email_message IS
  'Optional plain-text submitter copy email body. Null/blank retains the default; supports {{form_name}} and {{tenant_name}}.';
NOTIFY pgrst, 'reload schema';
COMMIT;
