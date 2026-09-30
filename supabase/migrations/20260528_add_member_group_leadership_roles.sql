-- Task #1153: Leadership role flag on Member Groups.
-- Adds a parallel leadership_roles text[] column to member_group so admins
-- can mark a subset of roles as "Leadership". The detail page uses this
-- to highlight a Leadership section listing assignments whose group_role
-- matches one of the leadership roles. Idempotent.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS leadership_roles TEXT[] NOT NULL DEFAULT '{}'::text[];
