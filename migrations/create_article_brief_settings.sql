-- Article Brief Settings: Tenant-configurable stages, categories, and notification toggles
CREATE TABLE IF NOT EXISTS article_brief_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  stages JSONB DEFAULT '[
    {"key":"new","label":"New","color":"#6b7280"},
    {"key":"assigned","label":"Assigned","color":"#3b82f6"},
    {"key":"in_progress","label":"In Progress","color":"#f59e0b"},
    {"key":"under_review","label":"Under Review","color":"#a855f7"},
    {"key":"changes_requested","label":"Changes Requested","color":"#f97316"},
    {"key":"approved","label":"Approved","color":"#22c55e"},
    {"key":"rejected","label":"Rejected","color":"#ef4444"}
  ]'::jsonb,
  categories JSONB DEFAULT '["General","News","Feature","Opinion","Review","Interview","Tutorial"]'::jsonb,
  notify_reviewer BOOLEAN DEFAULT false,
  notify_writer BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_article_brief_settings_tenant ON article_brief_settings(tenant_id);

-- Remove the CHECK constraint on article_brief.status so any tenant-defined stage value is accepted
ALTER TABLE article_brief DROP CONSTRAINT IF EXISTS article_brief_status_check;
