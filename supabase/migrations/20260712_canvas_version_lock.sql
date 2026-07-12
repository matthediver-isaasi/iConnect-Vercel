-- Lockable Canvas version history (Task #2759)
--
-- Canvas Builder keeps a rolling history of the last 10 page versions; older
-- ones are auto-pruned. Authors need a way to protect a known-good version so
-- it is never pruned. This adds an `is_locked` flag to canvas_page_version.
--
-- Locked versions:
--   * are never auto-deleted by pruneVersions,
--   * do NOT count toward the 10-version rolling limit,
--   * are always returned by the list query (in addition to the rolling 10).
-- A page can have at most 3 locked versions (enforced in the API, not the DB).
--
-- Idempotent: safe to run multiple times.

ALTER TABLE canvas_page_version
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false;

-- Speeds up the per-page locked lookups (list, prune, and the max-3 cap check).
CREATE INDEX IF NOT EXISTS idx_canvas_page_version_page_locked
  ON canvas_page_version(page_id, is_locked);

COMMENT ON COLUMN canvas_page_version.is_locked IS
  'When true the version is protected from pruning and excluded from the 10-version rolling limit (Task #2759). Max 3 locked per page, enforced in api/canvas-versions/[pageId].js.';
