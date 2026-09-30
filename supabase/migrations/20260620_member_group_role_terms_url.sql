-- Task #1655: Per-role terms-of-reference as a URL.
--
-- Adds a JSONB map on member_group keyed by role name -> terms-of-reference
-- URL. This supersedes the legacy `role_terms_of_reference` HTML map for the
-- role-invitation flows (the invite email and public invite page now link to
-- this URL instead of rendering authored terms text). The old column is left
-- in place for legacy data. Roles without their own entry simply have none.
-- Idempotent.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS role_terms_url JSONB NOT NULL DEFAULT '{}'::jsonb;
