-- Task #1626: Role term tracking — term length + max terms on the role.
--
-- Term length (value + unit) and maximum number of terms are a property of the
-- ROLE, not the vacancy. Roles on a member group are plain title strings
-- (member_group.roles); per-role rich data is already kept in a title-keyed
-- JSONB map (role_terms_of_reference). This adds a parallel title-keyed JSONB
-- map holding each role's term definition, following that same pattern:
--   { "<role title>": { "term_value": 3, "term_unit": "years", "max_terms": 2 } }
-- Idempotent; safe to re-run.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS role_term_definitions JSONB NOT NULL DEFAULT '{}'::jsonb;
