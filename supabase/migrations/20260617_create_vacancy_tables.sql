-- Task #1536: Group vacancy posting + member applications.
--
-- Group admins post "vacancies" (positions) against a member_group; logged-in
-- members express interest (apply) on open vacancies. Two new tenant-scoped,
-- group-scoped tables. Isolation is enforced at the API layer (the generic
-- entity API force-sets tenant_id from the session on write and filters reads
-- by tenant_id), mirroring the existing event_sponsor / crm_tag_color tables.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS vacancy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_group_id UUID NOT NULL REFERENCES member_group(id) ON DELETE CASCADE,
  posted_by_member_id UUID REFERENCES member(id) ON DELETE SET NULL,
  role_title TEXT NOT NULL,
  role_description TEXT NOT NULL,
  commitment_value NUMERIC,
  commitment_unit TEXT,
  term_value NUMERIC,
  term_unit TEXT,
  max_terms NUMERIC,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vacancy_application (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  vacancy_id UUID NOT NULL REFERENCES vacancy(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(vacancy_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_vacancy_tenant ON vacancy(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_group ON vacancy(member_group_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_application_tenant ON vacancy_application(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_application_vacancy ON vacancy_application(vacancy_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_application_member ON vacancy_application(member_id);
