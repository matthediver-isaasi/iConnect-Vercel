CREATE TABLE IF NOT EXISTS crm_tag_color (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  tag_name text NOT NULL,
  color text NOT NULL,
  UNIQUE(tenant_id, entity_type, tag_name)
);

CREATE INDEX IF NOT EXISTS idx_crm_tag_color_tenant ON crm_tag_color(tenant_id);
CREATE INDEX IF NOT EXISTS idx_crm_tag_color_lookup ON crm_tag_color(tenant_id, entity_type);
