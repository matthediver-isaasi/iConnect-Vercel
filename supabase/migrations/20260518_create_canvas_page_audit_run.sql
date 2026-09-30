-- Canvas page audit history (Task #919)
-- Persists each "Run full audit" axe-core scan against a canvas page so
-- authors can see how issues evolve over time and re-open past runs.
--
-- Separate from accessibility_audit / accessibility_audit_result because:
--   * those are admin-driven, URL-based multi-URL runs (one row per run,
--     many per URL),
--   * canvas audits are per-page, single-URL, run from the editor and
--     carry the editor's mapped issue payload (with blockId, severity
--     'error'|'warning'|'info', selector, html, helpUrl) which doesn't
--     fit the axe_result JSON shape stored by the admin runner.
--
-- One row per "Run full audit" click that completes successfully.

CREATE TABLE IF NOT EXISTS canvas_page_audit_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  page_id UUID NOT NULL REFERENCES i_edit_page(id) ON DELETE CASCADE,
  run_by_member_id UUID,
  run_by_tenant_user_id UUID,
  run_by_name TEXT,
  total_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  info_count INTEGER NOT NULL DEFAULT 0,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canvas_page_audit_run_page
  ON canvas_page_audit_run(page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canvas_page_audit_run_tenant
  ON canvas_page_audit_run(tenant_id, created_at DESC);

COMMENT ON TABLE canvas_page_audit_run IS
  'Persisted per-page axe-core audit runs from the Canvas page editor (Task #919). issues is the mapped issue array surfaced in the editor drawer.';
