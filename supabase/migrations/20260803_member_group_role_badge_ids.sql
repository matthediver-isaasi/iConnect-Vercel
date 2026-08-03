-- Task #3297: Attach badge-module badges to group roles.
--
-- Roles on a member group are plain title strings (member_group.roles);
-- per-role rich data is kept in title-keyed JSONB maps (role_terms_url,
-- role_term_definitions). This adds a parallel title-keyed JSONB map linking
-- each role to an optional badge from the Badges module (badge table):
--   { "<role title>": "<badge uuid>" }
-- Badge display on /about-me is DERIVED from current member_group_assignment
-- rows joined to this map — no member_badge rows are materialized.
-- Idempotent; safe to re-run.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS role_badge_ids JSONB NOT NULL DEFAULT '{}'::jsonb;
