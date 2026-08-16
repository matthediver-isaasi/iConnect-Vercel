-- Organisation Groups (Task: parent grouping above organisations)
-- Apply to the DEST database (production target).
--
-- One group has many organisations. Deleting a group DETACHES its
-- organisations (FK ON DELETE SET NULL) rather than deleting them.

CREATE TABLE IF NOT EXISTS organization_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  logo_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organization_group_tenant
  ON organization_group(tenant_id);

ALTER TABLE organization
  ADD COLUMN IF NOT EXISTS organization_group_id uuid
  REFERENCES organization_group(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_organization_group_id
  ON organization(organization_group_id);
