-- task-711: Per-page social/SEO fields for Page Builder (i_edit_page) records.
-- These override tenant-level Link Preview settings when set; blank values
-- fall back to tenant defaults via api/_lib/entityMeta.js + renderHtml.js.

ALTER TABLE i_edit_page ADD COLUMN IF NOT EXISTS seo_title text;
ALTER TABLE i_edit_page ADD COLUMN IF NOT EXISTS seo_description text;
ALTER TABLE i_edit_page ADD COLUMN IF NOT EXISTS og_image_url text;

COMMENT ON COLUMN i_edit_page.seo_title IS 'Per-page social/unfurl title (og:title / twitter:title). Falls back to meta_title or page title.';
COMMENT ON COLUMN i_edit_page.seo_description IS 'Per-page social/unfurl description (og:description / twitter:description / meta description). Falls back to tenant description.';
COMMENT ON COLUMN i_edit_page.og_image_url IS 'Per-page social card image URL (og:image / twitter:image, recommended 1200x630). Falls back to tenant social_image_url / logo.';
