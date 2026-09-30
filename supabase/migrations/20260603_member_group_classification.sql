-- Task #1242: Member Group Classifications.
--
-- Tenant-defined organisational labels for member groups (e.g. "Communities
-- of practice"). A group can be assigned exactly one classification (or none).
-- Classifications carry no permissions or behaviour — they are purely an
-- organisational/reporting label used to group and filter on the Member Group
-- Management page.
--
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS member_group_classification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenant(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE member_group_classification IS 'Tenant-defined organisational labels for grouping/filtering member groups. No permissions or behaviour.';

CREATE INDEX IF NOT EXISTS idx_member_group_classification_tenant_id
  ON member_group_classification(tenant_id);

-- Enable RLS with the standard app-layer policy (tenant isolation enforced in the API layer).
ALTER TABLE member_group_classification ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'member_group_classification'
      AND policyname = 'member_group_classification_tenant_isolation'
  ) THEN
    CREATE POLICY "member_group_classification_tenant_isolation"
      ON member_group_classification
      FOR ALL
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- Nullable reference from member_group; classification removal sets groups back to "no classification".
ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS classification_id UUID NULL
  REFERENCES member_group_classification(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_member_group_classification_id
  ON member_group(classification_id)
  WHERE classification_id IS NOT NULL;
