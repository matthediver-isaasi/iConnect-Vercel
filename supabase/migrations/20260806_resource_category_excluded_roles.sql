-- Task #3306: role-based resource category access.
-- excluded_role_ids lists member role ids that CANNOT see the category.
-- Empty (the default) = visible to all roles, preserving current behaviour
-- for every existing category and for roles created later.
ALTER TABLE resource_category
  ADD COLUMN IF NOT EXISTS excluded_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
