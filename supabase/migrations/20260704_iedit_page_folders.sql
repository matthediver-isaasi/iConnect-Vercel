-- Page organisation: folders, pinning (Task #2225).
--
-- Adds an admin-only organisation layer over `i_edit_page`:
--   * `i_edit_page_folder` — tenant-scoped folder tree (self-referencing
--     `parent_id` for nesting). Folders group pages in the admin page-manager
--     only; they never affect the public-facing site or navigation.
--   * `i_edit_page.folder_id` — which folder a page is filed under (NULL = the
--     root / "unfiled" view). ON DELETE SET NULL so deleting a folder never
--     deletes its pages; they fall back to the root view.
--   * `i_edit_page.pinned_at` — pin signal. Non-null = pinned; pinned pages
--     render above the sorted, non-pinned pages within their view.
--
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS i_edit_page_folder (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  parent_id     uuid        REFERENCES i_edit_page_folder(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  display_order integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'i_edit_page_folder'
      AND indexname  = 'idx_i_edit_page_folder_tenant'
  ) THEN
    CREATE INDEX idx_i_edit_page_folder_tenant
      ON i_edit_page_folder (tenant_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'i_edit_page_folder'
      AND indexname  = 'idx_i_edit_page_folder_parent'
  ) THEN
    CREATE INDEX idx_i_edit_page_folder_parent
      ON i_edit_page_folder (parent_id);
  END IF;
END $$;

ALTER TABLE i_edit_page
  ADD COLUMN IF NOT EXISTS folder_id uuid
    REFERENCES i_edit_page_folder(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'i_edit_page'
      AND indexname  = 'idx_i_edit_page_folder_id'
  ) THEN
    CREATE INDEX idx_i_edit_page_folder_id
      ON i_edit_page (folder_id);
  END IF;
END $$;

COMMENT ON TABLE i_edit_page_folder IS
  'Admin-only organisation folders for i_edit_page (page manager UI). Tenant-scoped; self-referencing parent_id allows nesting. Does not affect public navigation.';
COMMENT ON COLUMN i_edit_page.folder_id IS
  'Folder this page is filed under in the admin page manager (NULL = root/unfiled). ON DELETE SET NULL: deleting a folder returns its pages to the root view.';
COMMENT ON COLUMN i_edit_page.pinned_at IS
  'When set, the page is pinned to the top of its folder view in the admin page manager.';
