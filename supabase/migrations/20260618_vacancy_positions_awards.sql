-- Task #1550: Vacancy positions + awarding.
--
-- 1. vacancy.positions_available — how many people a vacancy needs (defaults to
--    1). Existing rows without an explicit value behave as a single position.
-- 2. vacancy_award                — records that a member has been awarded a
--    vacancy's position. Tenant-scoped + group-scoped, mirroring the existing
--    vacancy / vacancy_application tables. Isolation is enforced at the API
--    layer (the generic entity API force-sets tenant_id from the session on
--    write and filters reads by tenant_id). A uniqueness guard prevents the
--    same member being awarded the same vacancy twice.
-- Idempotent; safe to re-run.

ALTER TABLE vacancy
  ADD COLUMN IF NOT EXISTS positions_available INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS vacancy_award (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_group_id UUID NOT NULL REFERENCES member_group(id) ON DELETE CASCADE,
  vacancy_id UUID NOT NULL REFERENCES vacancy(id) ON DELETE CASCADE,
  awarded_member_id UUID NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  source_type TEXT,
  source_id UUID,
  awarded_by_member_id UUID REFERENCES member(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(vacancy_id, awarded_member_id)
);

CREATE INDEX IF NOT EXISTS idx_vacancy_award_tenant ON vacancy_award(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_award_group ON vacancy_award(member_group_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_award_vacancy ON vacancy_award(vacancy_id);
CREATE INDEX IF NOT EXISTS idx_vacancy_award_member ON vacancy_award(awarded_member_id);
