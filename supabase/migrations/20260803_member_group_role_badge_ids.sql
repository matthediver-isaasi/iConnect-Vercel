-- Task #3297: optional per-role badge links on member groups.
-- member_group.role_badge_ids maps a role name (free-text key, matched
-- case-insensitively by the app) to a badge.id. Badge display on member
-- profiles is fully DERIVED from current member_group_assignment rows plus
-- this map — no member_badge rows are materialized.
ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS role_badge_ids JSONB NOT NULL DEFAULT '{}'::jsonb;
