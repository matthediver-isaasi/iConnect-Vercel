-- Drop the unused member_group.ems_enabled_roles column.
--
-- Group-email sending is now gated by the per-person "Group Admin" flag
-- (member_group_assignment.is_group_admin) instead of the old
-- "Roles allowed to send group emails" list. The ems_enabled_roles TEXT[]
-- column on member_group is no longer read or written anywhere, so we drop
-- the dead data. Idempotent.

ALTER TABLE member_group
  DROP COLUMN IF EXISTS ems_enabled_roles;
