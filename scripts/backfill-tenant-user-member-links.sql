-- Backfill: Link existing tenant_users to their corresponding member records
-- Run this SQL in your Supabase SQL Editor after creating the tenant_user_member_link table

-- First, ensure the link table exists (run create-tenant-user-member-link.sql first if not)

-- Link tenant_users to members by matching email and tenant
INSERT INTO tenant_user_member_link (tenant_user_id, member_id, tenant_id)
SELECT 
  tu.id AS tenant_user_id,
  m.id AS member_id,
  tu.tenant_id
FROM tenant_user tu
JOIN member m ON LOWER(tu.email) = LOWER(m.email)
JOIN organization o ON m.organization_id = o.id
WHERE o.tenant_id = tu.tenant_id
  AND NOT EXISTS (
    SELECT 1 FROM tenant_user_member_link link 
    WHERE link.tenant_user_id = tu.id AND link.member_id = m.id
  );

-- Report what was linked
SELECT 
  tu.email,
  t.name AS tenant_name,
  m.first_name || ' ' || m.last_name AS member_name,
  r.name AS role_name
FROM tenant_user_member_link link
JOIN tenant_user tu ON link.tenant_user_id = tu.id
JOIN member m ON link.member_id = m.id
JOIN tenant t ON link.tenant_id = t.id
LEFT JOIN role r ON m.role_id = r.id;
