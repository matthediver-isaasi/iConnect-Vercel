-- Task #2525: per-microsite branding overrides (visual branding cards in
-- /MicrositeManagement). Stores only the whitelisted override keys the
-- microsite sets (primary_color, secondary_color, logo_url, header_logo_url,
-- social_image_url, tagline, description, headerSocialIconColor,
-- footerSocialIconColor). Empty/absent keys fall back to the tenant value.
-- Idempotent: safe to re-run.

ALTER TABLE microsite
  ADD COLUMN IF NOT EXISTS branding_config jsonb NOT NULL DEFAULT '{}'::jsonb;
