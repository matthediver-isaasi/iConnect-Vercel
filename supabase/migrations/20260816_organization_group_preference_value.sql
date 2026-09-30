-- Organisation Group custom field values (Task #3601)
-- Apply to the DEST database (production target).
--
-- Mirrors organization_preference_value: one row per (group, field),
-- tenant-scoped. Field definitions live in preference_field with
-- entity_scope = 'organization_group'.

CREATE TABLE IF NOT EXISTS organization_group_preference_value (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  organization_group_id uuid NOT NULL REFERENCES organization_group(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES preference_field(id) ON DELETE CASCADE,
  value text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_group_preference_value_unique
    UNIQUE (organization_group_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_org_group_pref_value_tenant
  ON organization_group_preference_value(tenant_id);
CREATE INDEX IF NOT EXISTS idx_org_group_pref_value_group
  ON organization_group_preference_value(organization_group_id);
