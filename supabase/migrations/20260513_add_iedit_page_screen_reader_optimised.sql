-- Add screen-reader-optimised toggle to CMS pages.
-- Per-page pilot flag for the screen-reader rollout: when true, the page
-- renders with the full SR treatment (single h1, accessible dialog gallery,
-- ARIA on carousels/accordions/tabs, image alt rules, transcript region,
-- live region for async announcements). Off by default everywhere.

ALTER TABLE i_edit_page
  ADD COLUMN IF NOT EXISTS screen_reader_optimised boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN i_edit_page.screen_reader_optimised IS
  'When true, the page renders with screen-reader optimisations enabled (pilot).';
