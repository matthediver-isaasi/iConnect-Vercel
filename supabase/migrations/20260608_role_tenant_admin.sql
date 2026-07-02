-- Tenant-level admin flag on roles.
--
-- When `is_tenant_admin` is true, the role represents a tenant-level
-- administrator and is hidden from the Role selector in the Edit Member
-- modal on /Team, so it can't be assigned to ordinary members from there.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE role ADD COLUMN IF NOT EXISTS is_tenant_admin BOOLEAN NOT NULL DEFAULT false;
