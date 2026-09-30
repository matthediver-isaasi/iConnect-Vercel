CREATE TABLE IF NOT EXISTS audience_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  communication_category_id UUID REFERENCES communication_category(id),
  target_audiences JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audience_list_tenant_id ON audience_list(tenant_id);
