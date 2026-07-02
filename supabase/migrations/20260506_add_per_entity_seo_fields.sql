-- task-714: Per-entity social/unfurl override fields for public detail pages.
-- Mirrors the i_edit_page seo_title / seo_description / og_image_url pattern
-- introduced in task-711. Each column overrides the auto-derived value used
-- by api/_lib/entityMeta.js; blank values fall back to the existing logic
-- (auto-derived title/summary/image, then tenant defaults).

-- Events: seo_title / seo_description already exist from prior work.
ALTER TABLE event ADD COLUMN IF NOT EXISTS og_image_url text;
COMMENT ON COLUMN event.og_image_url IS 'Per-event social card image URL (og:image / twitter:image, recommended 1200x630). Falls back to event image_url, then tenant social_image_url.';

-- Complex events
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS og_image_url text;
COMMENT ON COLUMN complex_event.og_image_url IS 'Per-event social card image URL (og:image / twitter:image, recommended 1200x630). Falls back to event image_url, then tenant social_image_url.';

-- Blog posts: seo_title / seo_description already exist.
ALTER TABLE blog_post ADD COLUMN IF NOT EXISTS og_image_url text;
COMMENT ON COLUMN blog_post.og_image_url IS 'Per-article social card image URL. Falls back to feature_image_url, then tenant social_image_url.';

-- News posts: seo_title / seo_description already exist.
ALTER TABLE news_post ADD COLUMN IF NOT EXISTS og_image_url text;
COMMENT ON COLUMN news_post.og_image_url IS 'Per-news social card image URL. Falls back to feature_image_url, then tenant social_image_url.';

-- Fundraising campaigns: full SEO/social override set.
ALTER TABLE fundraising_campaign ADD COLUMN IF NOT EXISTS seo_title text;
ALTER TABLE fundraising_campaign ADD COLUMN IF NOT EXISTS seo_description text;
ALTER TABLE fundraising_campaign ADD COLUMN IF NOT EXISTS og_image_url text;
COMMENT ON COLUMN fundraising_campaign.seo_title IS 'Per-campaign social/unfurl title. Falls back to campaign name.';
COMMENT ON COLUMN fundraising_campaign.seo_description IS 'Per-campaign social/unfurl description. Falls back to public_description / description.';
COMMENT ON COLUMN fundraising_campaign.og_image_url IS 'Per-campaign social card image URL. Falls back to cover_image_url, then tenant social_image_url.';

-- Resources: full SEO/social override set.
ALTER TABLE resource ADD COLUMN IF NOT EXISTS seo_title text;
ALTER TABLE resource ADD COLUMN IF NOT EXISTS seo_description text;
ALTER TABLE resource ADD COLUMN IF NOT EXISTS og_image_url text;
COMMENT ON COLUMN resource.seo_title IS 'Per-resource social/unfurl title. Falls back to resource title.';
COMMENT ON COLUMN resource.seo_description IS 'Per-resource social/unfurl description. Falls back to resource description.';
COMMENT ON COLUMN resource.og_image_url IS 'Per-resource social card image URL. Falls back to image_url, then tenant social_image_url.';

-- Dynamic directories: full SEO/social override set.
ALTER TABLE dynamic_directory ADD COLUMN IF NOT EXISTS seo_title text;
ALTER TABLE dynamic_directory ADD COLUMN IF NOT EXISTS seo_description text;
ALTER TABLE dynamic_directory ADD COLUMN IF NOT EXISTS og_image_url text;
COMMENT ON COLUMN dynamic_directory.seo_title IS 'Per-directory social/unfurl title. Falls back to directory name.';
COMMENT ON COLUMN dynamic_directory.seo_description IS 'Per-directory social/unfurl description. Falls back to directory description.';
COMMENT ON COLUMN dynamic_directory.og_image_url IS 'Per-directory social card image URL. Falls back to tenant social_image_url.';
