-- Task #3320: per-subcategory role exclusions on resource categories.
-- JSONB map of subcategory name -> array of role ids that CANNOT see that
-- subcategory. Empty map (the default) = every subcategory follows its
-- category's own visibility, preserving current behaviour for every existing
-- category (no data migration needed).
ALTER TABLE resource_category
  ADD COLUMN IF NOT EXISTS subcategory_excluded_role_ids JSONB NOT NULL DEFAULT '{}'::jsonb;
