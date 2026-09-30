-- Canvas Builder Phase 1 — Foundation.
-- Adds per-page builder selector and canvas design document storage to
-- `i_edit_page`. Existing rows keep the legacy iEdit element renderer
-- (builder_type = 'iedit'); rows created via the new Canvas Builder flow
-- set builder_type = 'canvas' and persist their layout in `canvas_design`.
--
-- canvas_design JSON schema (version 1):
--   {
--     "version": 1,
--     "root": {
--       "background": null,
--       "sections": [
--         {
--           "id": string,
--           "name": string,
--           "background": null,
--           "children": [
--             {
--               "id": string,
--               "type": string,                 // block type, e.g. text|image|button
--               "position": { "x": number, "y": number, "w": number, "h": number },
--               "breakpoints": {
--                 "desktop": { "x": number, "y": number, "w": number, "h": number },
--                 "tablet":  { "x": number, "y": number, "w": number, "h": number },
--                 "mobile":  { "x": number, "y": number, "w": number, "h": number }
--               },
--               "a11y": { "alt": string, "ariaLabel": string, "role": string, "headingLevel": number },
--               "props": { ... }                // block-specific props
--             }
--           ]
--         }
--       ]
--     }
--   }
--
-- Phase 1 ships the foundation only: data model, page-level toggle, editor
-- shell, routing plumbing, public renderer stub, SEO integration. No block
-- types are wired up yet.

ALTER TABLE i_edit_page
  ADD COLUMN IF NOT EXISTS builder_type text NOT NULL DEFAULT 'iedit',
  ADD COLUMN IF NOT EXISTS canvas_design jsonb;

-- Server-side default: when a Canvas page is created without supplying
-- canvas_design, populate an empty normalized design document. This avoids
-- null design docs and the "first save to initialize" edge behaviour in
-- the editor. iEdit pages keep canvas_design = NULL.
CREATE OR REPLACE FUNCTION i_edit_page_default_canvas_design()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.builder_type = 'canvas' AND NEW.canvas_design IS NULL THEN
    -- Keep the default in lock-step with createEmptyCanvasDesign() in
    -- client/src/lib/canvasDesign.js: background defaults to null, not {}.
    NEW.canvas_design := jsonb_build_object(
      'version', 1,
      'root', jsonb_build_object(
        'background', NULL,
        'sections', '[]'::jsonb
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS i_edit_page_default_canvas_design_trg ON i_edit_page;

CREATE TRIGGER i_edit_page_default_canvas_design_trg
  BEFORE INSERT ON i_edit_page
  FOR EACH ROW
  EXECUTE FUNCTION i_edit_page_default_canvas_design();

ALTER TABLE i_edit_page
  DROP CONSTRAINT IF EXISTS i_edit_page_builder_type_check;

ALTER TABLE i_edit_page
  ADD CONSTRAINT i_edit_page_builder_type_check
  CHECK (builder_type IN ('iedit', 'canvas'));

COMMENT ON COLUMN i_edit_page.builder_type IS
  'Which page builder this page uses: ''iedit'' (legacy element renderer) or ''canvas'' (free-form Canvas Builder). Set at creation; not user-switchable.';
COMMENT ON COLUMN i_edit_page.canvas_design IS
  'Canvas Builder design document (jsonb). Only used when builder_type = ''canvas''. See migration file header for the schema.';

-- Enforce builder_type immutability after the row is created. The UI also
-- guards this, but the database is the source of truth: once a page is
-- created with a given builder it stays on that builder for life. This
-- avoids data-shape mismatches between canvas_design and i_edit_page_element.
CREATE OR REPLACE FUNCTION i_edit_page_lock_builder_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.builder_type IS DISTINCT FROM OLD.builder_type THEN
    RAISE EXCEPTION 'i_edit_page.builder_type is immutable after creation (was %, attempted %)',
      OLD.builder_type, NEW.builder_type
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS i_edit_page_lock_builder_type_trg ON i_edit_page;

CREATE TRIGGER i_edit_page_lock_builder_type_trg
  BEFORE UPDATE ON i_edit_page
  FOR EACH ROW
  EXECUTE FUNCTION i_edit_page_lock_builder_type();
