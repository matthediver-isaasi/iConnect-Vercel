-- Optional, versioned audience restrictions for public forms.
-- NULL keeps all existing forms unrestricted.
ALTER TABLE form
  ADD COLUMN IF NOT EXISTS access_policy JSONB;

COMMENT ON COLUMN form.access_policy IS
  'Versioned form audience policy: member-group rules, tenant RBAC role ids, and group-vs-RBAC operator. NULL is unrestricted.';