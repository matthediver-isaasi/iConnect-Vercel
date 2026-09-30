-- Task #1513: Explicit Group Admin flag on member group assignments.
-- Adds an is_group_admin boolean to member_group_assignment so admins can
-- explicitly designate a member/guest as a group admin per-assignment,
-- independent of the group's leadership_roles. Idempotent.

ALTER TABLE member_group_assignment
  ADD COLUMN IF NOT EXISTS is_group_admin BOOLEAN NOT NULL DEFAULT false;
