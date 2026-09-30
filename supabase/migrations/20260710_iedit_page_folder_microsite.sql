-- Task #2534: Scope page-manager folders to microsites.
--
-- Adds a nullable `microsite_id` to `i_edit_page_folder` so the admin
-- page-manager can organise each microsite's pages into their own folder
-- tree, separate from the primary-site folders.
--   * `microsite_id` NULL  = a primary-site folder (existing behaviour).
--   * `microsite_id` set    = a folder belonging to that microsite.
--
-- FK ON DELETE SET NULL mirrors how `i_edit_page.folder_id` is handled:
-- deleting a microsite never deletes its folders; they fall back to the
-- primary-site view. This column is admin-only organisation metadata and has
-- NO effect on public page rendering, navigation, or microsite routing.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE i_edit_page_folder
  ADD COLUMN IF NOT EXISTS microsite_id uuid
    REFERENCES microsite(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'i_edit_page_folder'
      AND indexname  = 'idx_i_edit_page_folder_microsite'
  ) THEN
    CREATE INDEX idx_i_edit_page_folder_microsite
      ON i_edit_page_folder (microsite_id) WHERE microsite_id IS NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN i_edit_page_folder.microsite_id IS
  'Microsite this folder belongs to in the admin page manager (NULL = primary tenant site). ON DELETE SET NULL: deleting a microsite returns its folders to the primary-site view. Admin-only organisation metadata; does not affect public rendering, navigation, or routing.';
