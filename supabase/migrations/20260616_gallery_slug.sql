-- Add a URL handle (`slug`) to gallery so each gallery can be opened on its
-- own shareable page at /gallery/:slug.
--
-- Slugs are unique per tenant (a partial unique index keyed on tenant_id +
-- slug, ignoring NULLs). Existing galleries are backfilled with a slug derived
-- from their title, de-duplicated within each tenant with a numeric suffix.
-- Idempotent: re-running only fills rows that still have no slug and the index
-- is created IF NOT EXISTS.

ALTER TABLE gallery ADD COLUMN IF NOT EXISTS slug text;

-- Backfill slug from title for rows that don't have one yet, unique per tenant.
WITH base AS (
  SELECT
    id,
    tenant_id,
    NULLIF(
      trim(both '-' from regexp_replace(lower(coalesce(title, '')), '[^a-z0-9]+', '-', 'g')),
      ''
    ) AS base_slug
  FROM gallery
  WHERE slug IS NULL OR slug = ''
),
numbered AS (
  SELECT
    id,
    tenant_id,
    coalesce(base_slug, 'gallery') AS base_slug,
    row_number() OVER (
      PARTITION BY tenant_id, coalesce(base_slug, 'gallery')
      ORDER BY id
    ) AS rn
  FROM base
)
UPDATE gallery g
SET slug = CASE WHEN n.rn = 1 THEN n.base_slug ELSE n.base_slug || '-' || n.rn END
FROM numbered n
WHERE g.id = n.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_tenant_slug
  ON gallery(tenant_id, slug)
  WHERE slug IS NOT NULL;
