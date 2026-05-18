-- Task #926: Add per-view severity counts to canvas page audit runs.
--
-- Dual-view audits (Task #925) tag each issue with the view it was
-- found in ('member' | 'public'), but the persisted history row only
-- stored a single combined error/warning/info count. Authors comparing
-- trends over time couldn't tell whether the Public or Member view
-- regressed. This adds an optional JSONB column with per-view totals,
-- e.g. { "member": { "error": 1, "warning": 2, "info": 0, "total": 3 },
--        "public": { "error": 0, "warning": 1, "info": 4, "total": 5 } }.
--
-- Older rows (single-view) leave this NULL and the UI falls back to
-- the existing aggregate counts.

ALTER TABLE canvas_page_audit_run
  ADD COLUMN IF NOT EXISTS view_counts JSONB,
  ADD COLUMN IF NOT EXISTS failed_views TEXT[];

COMMENT ON COLUMN canvas_page_audit_run.view_counts IS
  'Per-view severity totals for dual-view audits (Task #926). NULL for single-view runs; otherwise an object keyed by view name (member|public) with { error, warning, info, total } integer counts. Excludes views whose axe-core pass failed — see failed_views.';

COMMENT ON COLUMN canvas_page_audit_run.failed_views IS
  'List of audited view names whose axe-core pass errored out (Task #926). Used by the history UI to distinguish a clean zero-finding view from one that was never successfully scanned.';
