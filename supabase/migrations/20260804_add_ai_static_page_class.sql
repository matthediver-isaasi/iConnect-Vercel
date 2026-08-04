-- Task #3371 — Static "AI generated" page class.
--
-- Adds a third builder_type value 'ai_static' alongside 'iedit' and 'canvas'.
-- Pages of this class store pre-authored, store-time-sanitized HTML plus CSS
-- that is scoped (at store time) under the page's own wrapper attribute
-- ([data-static-page="<page id>"]) so it cannot bleed into tenant chrome.
-- They render read-only: there is no builder/editor for this class — admins
-- can only manage metadata (title, slug, status, chrome flags).
--
-- Creation happens via platform tooling/seed scripts only; the generic entity
-- API rejects creating ai_static pages and strips static_html/static_css from
-- create/update payloads (see api/entities/[entity]).

ALTER TABLE i_edit_page
  ADD COLUMN IF NOT EXISTS static_html text,
  ADD COLUMN IF NOT EXISTS static_css text;

ALTER TABLE i_edit_page
  DROP CONSTRAINT IF EXISTS i_edit_page_builder_type_check;

ALTER TABLE i_edit_page
  ADD CONSTRAINT i_edit_page_builder_type_check
  CHECK (builder_type IN ('iedit', 'canvas', 'ai_static'));

COMMENT ON COLUMN i_edit_page.static_html IS
  'Sanitized static page body HTML. Only used when builder_type = ''ai_static''. Sanitized at store time (DOMPurify server-side); never accepted raw from the entity API.';
COMMENT ON COLUMN i_edit_page.static_css IS
  'Page CSS for builder_type = ''ai_static'', scoped at store time so every selector starts with [data-static-page="<page id>"].';
