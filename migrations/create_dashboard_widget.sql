-- Dashboard widget builder engine (task #606)
-- Creates the dashboard_widget table that backs the dynamic dashboard
-- builder. Widgets can either be SHARED (visible to all members of a
-- tenant) or PERSONAL (visible to a single owning member).
--
-- Note: tenant_id is stored as a UUID without an FK to tenant(id) because
-- some deployments are single-tenant and have no tenant table; the column
-- is still required so multi-tenant deployments stay properly scoped.

CREATE TABLE IF NOT EXISTS dashboard_widget (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  scope VARCHAR(20) NOT NULL CHECK (scope IN ('shared', 'personal')),
  owner_member_id UUID REFERENCES member(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  widget_type VARCHAR(20) NOT NULL CHECK (widget_type IN ('stat', 'bar', 'pie', 'donut', 'line')),
  width VARCHAR(10) NOT NULL DEFAULT 'third' CHECK (width IN ('third', 'half', 'full')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES member(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Personal widgets must have an owner; shared widgets must not.
  CONSTRAINT dashboard_widget_scope_owner_check CHECK (
    (scope = 'personal' AND owner_member_id IS NOT NULL)
    OR (scope = 'shared' AND owner_member_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_dashboard_widget_tenant_scope
  ON dashboard_widget(tenant_id, scope, display_order);

CREATE INDEX IF NOT EXISTS idx_dashboard_widget_owner
  ON dashboard_widget(owner_member_id, display_order)
  WHERE owner_member_id IS NOT NULL;
