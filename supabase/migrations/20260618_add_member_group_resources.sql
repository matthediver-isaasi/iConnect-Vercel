-- Task #1575: Group Resources feature.
-- Mirrors Group Events (#1144): resources can be linked back to a member_group
-- so each group has its own Resources card on /MemberGroupDetail. Each member
-- group also gets its own File Repository folder (linked via member_group_id)
-- where group resource uploads land for tenant admins. Idempotent.

ALTER TABLE resource
  ADD COLUMN IF NOT EXISTS member_group_id UUID NULL REFERENCES member_group(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_resource_member_group_id
  ON resource(member_group_id)
  WHERE member_group_id IS NOT NULL;

ALTER TABLE file_repository_folder
  ADD COLUMN IF NOT EXISTS member_group_id UUID NULL REFERENCES member_group(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_file_repository_folder_member_group_id
  ON file_repository_folder(member_group_id)
  WHERE member_group_id IS NOT NULL;
