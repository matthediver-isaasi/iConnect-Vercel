-- Task #1133: Group Projects feature.
-- Mirrors the group-email enable pattern. Member groups can be flagged
-- projects_enabled with a per-group projects_enabled_roles list; project
-- boards can be linked back to a member_group so we can sync membership and
-- archive on disable. Idempotent.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS projects_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS projects_enabled_roles TEXT[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE project_board
  ADD COLUMN IF NOT EXISTS member_group_id UUID NULL REFERENCES member_group(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_project_board_member_group_id
  ON project_board(member_group_id)
  WHERE member_group_id IS NOT NULL;
