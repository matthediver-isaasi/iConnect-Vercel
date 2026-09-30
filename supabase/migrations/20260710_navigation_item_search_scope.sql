-- Task #2627: microsite header search scope toggle.
-- Adds a per-navigation-item `include_outside_microsite` flag so a microsite's
-- Search header element can be scoped to that microsite's results only. Mirrors
-- the Canvas Builder Search Input block's "Include results from outside this
-- microsite" toggle. Defaults to TRUE = search the whole site (existing
-- behaviour); FALSE = restrict to the microsite the search element lives on.
-- Idempotent: safe to re-run.

ALTER TABLE navigation_item
  ADD COLUMN IF NOT EXISTS include_outside_microsite boolean NOT NULL DEFAULT true;
