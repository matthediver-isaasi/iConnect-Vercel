-- Task #1608: Per-role terms of reference for member groups.
--
-- Adds a JSONB map on member_group keyed by role name -> terms-of-reference
-- HTML. This is additive to the existing group-level `terms_of_reference`
-- column (which stays as the fallback used by the self-join flow). Roles
-- without their own entry simply have none. Idempotent.

ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS role_terms_of_reference JSONB NOT NULL DEFAULT '{}'::jsonb;
