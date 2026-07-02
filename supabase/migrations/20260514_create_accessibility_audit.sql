-- Accessibility Audits (Task #850)
-- Tenant-scoped accessibility audit runs powered by browserless.io + axe-core.
-- Each run captures one or more URLs; each URL gets a row in
-- accessibility_audit_result that stores the full axe-core JSON output.

CREATE TABLE IF NOT EXISTS accessibility_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  requested_by_member_id UUID,
  requested_by_tenant_user_id UUID,
  requested_by_name TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  urls TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  critical_count INTEGER NOT NULL DEFAULT 0,
  serious_count INTEGER NOT NULL DEFAULT 0,
  moderate_count INTEGER NOT NULL DEFAULT 0,
  minor_count INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  violation_count INTEGER NOT NULL DEFAULT 0,
  score NUMERIC,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accessibility_audit_tenant
  ON accessibility_audit(tenant_id);
CREATE INDEX IF NOT EXISTS idx_accessibility_audit_tenant_created
  ON accessibility_audit(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS accessibility_audit_result (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES accessibility_audit(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  critical_count INTEGER NOT NULL DEFAULT 0,
  serious_count INTEGER NOT NULL DEFAULT 0,
  moderate_count INTEGER NOT NULL DEFAULT 0,
  minor_count INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  violation_count INTEGER NOT NULL DEFAULT 0,
  score NUMERIC,
  axe_result JSONB,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accessibility_audit_result_audit
  ON accessibility_audit_result(audit_id);
CREATE INDEX IF NOT EXISTS idx_accessibility_audit_result_tenant
  ON accessibility_audit_result(tenant_id);

COMMENT ON TABLE accessibility_audit IS
  'Tenant-scoped accessibility audit runs. One row per "Run audit" action.';
COMMENT ON TABLE accessibility_audit_result IS
  'Per-URL accessibility audit result. Stores the full axe-core JSON output in axe_result.';
