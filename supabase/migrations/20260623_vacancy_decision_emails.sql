-- Task #1700: Vacancy approve/decline decision emails.
--
-- 1. member_group.approval_email_template_id / decline_email_template_id —
--    optional group-level email templates used when awarding (approval) or
--    declining (decline) a vacancy application/submission.
-- 2. vacancy_decline — records that an application/submission was declined,
--    mirroring vacancy_award's source_type/source_id shape so both form
--    submissions and legacy express-interest applications are covered.
-- 3. vacancy_decision_email — persists each sent decision email (approval or
--    decline) for later reference, modelled on form_submission_email.
--
-- Tenant isolation is enforced at the API layer (the generic entity API forces
-- tenant_id from the session on write and filters reads by tenant_id; the
-- decision endpoint inserts these rows directly under group-admin authz).
-- Idempotent; safe to re-run.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS approval_email_template_id UUID REFERENCES email_template(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decline_email_template_id UUID REFERENCES email_template(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS vacancy_decline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_group_id UUID NOT NULL REFERENCES member_group(id) ON DELETE CASCADE,
  vacancy_id UUID NOT NULL REFERENCES vacancy(id) ON DELETE CASCADE,
  declined_member_id UUID REFERENCES member(id) ON DELETE SET NULL,
  source_type TEXT,
  source_id UUID,
  declined_by_member_id UUID REFERENCES member(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vacancy_decline_tenant ON vacancy_decline(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_decline_group ON vacancy_decline(member_group_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_decline_vacancy ON vacancy_decline(vacancy_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_decline_source ON vacancy_decline(source_id);

-- One decline per (vacancy, source) so a single application/submission cannot
-- be declined twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vacancy_decline_vacancy_source
  ON vacancy_decline(vacancy_id, source_id)
  WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vacancy_decision_email (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_group_id UUID REFERENCES member_group(id) ON DELETE CASCADE,
  vacancy_id UUID REFERENCES vacancy(id) ON DELETE CASCADE,
  decision_type TEXT NOT NULL,
  source_type TEXT,
  source_id UUID,
  to_email TEXT NOT NULL,
  cc_email TEXT,
  subject TEXT NOT NULL,
  body_html TEXT,
  sent_by_email TEXT,
  sent_by_member_id UUID REFERENCES member(id) ON DELETE SET NULL,
  delivery_status TEXT DEFAULT 'sent',
  delivery_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vacancy_decision_email_tenant ON vacancy_decision_email(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_decision_email_group ON vacancy_decision_email(member_group_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_decision_email_vacancy ON vacancy_decision_email(vacancy_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_decision_email_source ON vacancy_decision_email(source_id);
