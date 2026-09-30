-- Task #1266: Reply emails from form submissions.
--
-- Admins on the Form Submissions page can send a free-text reply email to a
-- submitter (often a non-member, so no member/CRM record exists). Each sent
-- reply is recorded here so it can be shown back on the submission row and the
-- submission detail view.
--
--   form_submission_email.submission_id : the submission the reply relates to.
--   to_email / cc_email / bcc_email      : resolved recipients at send time.
--   subject / body_html                  : the composed message (free text).
--   sent_by_email / sent_by_member_id    : the admin who sent it.
--   delivery_status                      : 'sent' or 'failed' (sendEmail never
--                                          throws — it returns success/error).
--   delivery_error                       : provider error string when failed.
--
-- Tenant-scoped (tenant_id) so the generic entity API can list it. Idempotent;
-- safe to re-run on any environment.

BEGIN;

CREATE TABLE IF NOT EXISTS form_submission_email (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  submission_id UUID NOT NULL REFERENCES form_submission(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  cc_email TEXT,
  bcc_email TEXT,
  subject TEXT NOT NULL,
  body_html TEXT,
  sent_by_email TEXT,
  sent_by_member_id UUID,
  delivery_status TEXT NOT NULL DEFAULT 'sent',
  delivery_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Idempotently ensure the FK exists even on databases where the table was
-- created by an earlier version of this migration (CREATE TABLE IF NOT EXISTS
-- would otherwise skip the inline REFERENCES above).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'form_submission_email_submission_id_fkey'
  ) THEN
    ALTER TABLE form_submission_email
      ADD CONSTRAINT form_submission_email_submission_id_fkey
      FOREIGN KEY (submission_id) REFERENCES form_submission(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_form_submission_email_submission
  ON form_submission_email(submission_id);
CREATE INDEX IF NOT EXISTS idx_form_submission_email_tenant
  ON form_submission_email(tenant_id);
CREATE INDEX IF NOT EXISTS idx_form_submission_email_submission_created
  ON form_submission_email(submission_id, created_at DESC);

COMMENT ON TABLE form_submission_email IS
  'Free-text reply emails sent by admins to form submitters. One row per sent reply (Task #1266).';

COMMIT;

NOTIFY pgrst, 'reload schema';
