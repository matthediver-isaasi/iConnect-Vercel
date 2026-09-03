-- Gallery access policy is evaluated by the application server.  The JSONB
-- contract is deliberately versioned so future policy additions are explicit.
ALTER TABLE gallery ADD COLUMN IF NOT EXISTS access_policy jsonb;
ALTER TABLE gallery ADD COLUMN IF NOT EXISTS slug text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_tenant_slug
  ON gallery(tenant_id, slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gallery_tenant_public
  ON gallery(tenant_id, is_public);