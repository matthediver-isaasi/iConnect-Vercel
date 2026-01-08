-- Rename existing Administrator roles to Super Admin
-- Run this SQL in your Supabase SQL Editor

UPDATE role
SET name = 'Super Admin'
WHERE name = 'Administrator';

-- Verify the update
SELECT id, name, tenant_id, is_default, excluded_features
FROM role
WHERE name = 'Super Admin';
