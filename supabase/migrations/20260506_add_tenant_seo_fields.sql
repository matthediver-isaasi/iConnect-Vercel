-- task-697: Tenant SEO / unfurl fields used by SSR HTML handler (api/render.js).
-- description -> meta description + og:description
-- social_image_url -> og:image / twitter:image (1200x630). Falls back to logo_url.

ALTER TABLE tenant ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS social_image_url text;

COMMENT ON COLUMN tenant.description IS 'Short tenant description used as meta description and og:description for link unfurls.';
COMMENT ON COLUMN tenant.social_image_url IS 'Absolute URL of a 1200x630 social card image used for og:image / twitter:image. Falls back to logo_url.';
