-- Task #1701: Link resource subcategories to member groups.
--
-- Adds `resource_subcategories` to member_group: the set of resource subcategory
-- names an admin links to the group. The group's Resources card surfaces tenant
-- resources tagged with any of these subcategories, group-created resources are
-- auto-tagged with them, and such auto-tagged group resources become visible
-- tenant-wide on /Resources under the matching filter.
--
-- Idempotent; safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'member_group'
      AND column_name = 'resource_subcategories'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN resource_subcategories TEXT[] NOT NULL DEFAULT '{}';
  END IF;
END $$;
