-- Target public floaters at the tenant's default site, selected microsites, or both.
-- NULL is intentional: existing floaters retain their legacy "all public sites" behavior.

ALTER TABLE floater
  ADD COLUMN IF NOT EXISTS site_targets jsonb;

ALTER TABLE floater
  DROP CONSTRAINT IF EXISTS floater_site_targets_shape_check;

ALTER TABLE floater
  ADD CONSTRAINT floater_site_targets_shape_check
  CHECK (
    site_targets IS NULL
    OR (
      jsonb_typeof(site_targets) = 'object'
      AND site_targets ? 'main_site'
      AND jsonb_typeof(site_targets -> 'main_site') = 'boolean'
      AND site_targets ? 'microsite_ids'
      AND jsonb_typeof(site_targets -> 'microsite_ids') = 'array'
      AND (
        (site_targets ->> 'main_site')::boolean
        OR jsonb_array_length(site_targets -> 'microsite_ids') > 0
      )
    )
  );

-- Supports containment lookups if public targeting moves server-side later.
CREATE INDEX IF NOT EXISTS floater_site_targets_gin_idx
  ON floater USING gin (site_targets jsonb_path_ops)
  WHERE site_targets IS NOT NULL;

COMMENT ON COLUMN floater.site_targets IS
  'Nullable public-site targeting: {main_site:boolean, microsite_ids:uuid[]}; NULL preserves legacy all-sites visibility.';