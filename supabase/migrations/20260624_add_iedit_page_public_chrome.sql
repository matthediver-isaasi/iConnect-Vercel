-- Add per-page public chrome control to CMS pages.
-- For pages rendered with the public layout (layout_type = 'public', or a
-- guest viewing a 'hybrid' page), this controls which parts of the public
-- site chrome are shown:
--   'both'   - public header AND footer (default, existing behaviour)
--   'none'   - neither header nor footer
--   'header' - header only
--   'footer' - footer only
-- Access (who can view the page) is still governed entirely by layout_type;
-- this column only affects chrome rendering.

ALTER TABLE i_edit_page
  ADD COLUMN IF NOT EXISTS public_chrome text NOT NULL DEFAULT 'both';

COMMENT ON COLUMN i_edit_page.public_chrome IS
  'For public-layout rendering, which site chrome to show: both | none | header | footer. Default both.';

-- Guard against invalid persisted values (idempotent — ADD CONSTRAINT has no
-- IF NOT EXISTS, so check the catalog first).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'i_edit_page_public_chrome_check'
  ) THEN
    ALTER TABLE i_edit_page
      ADD CONSTRAINT i_edit_page_public_chrome_check
      CHECK (public_chrome IN ('both', 'none', 'header', 'footer'));
  END IF;
END $$;
