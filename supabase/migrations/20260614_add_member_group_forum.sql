-- Task #1421: Group Forum feature.
-- Mirrors Group Projects (#1133) / Group Events (#1144): member groups can be
-- flagged forum_enabled with a per-group forum_enabled_roles list. A
-- forum_category is linked back to a member_group via its existing group_id
-- column; enabling provisions/reactivates that category, disabling deactivates
-- it (threads/posts are preserved). Idempotent; safe to re-run.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS forum_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS forum_enabled_roles TEXT[] NOT NULL DEFAULT '{}'::text[];

-- forum_category.group_id already exists (see api/admin/init-forum-tables.js).
-- Ensure the lookup index is present for group -> category resolution.
CREATE INDEX IF NOT EXISTS idx_forum_category_group ON forum_category(group_id);
