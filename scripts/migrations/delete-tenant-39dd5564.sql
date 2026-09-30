-- Delete orphaned tenant: 39dd5564-073f-4902-a24b-23037cf9d178
-- Run this in Supabase SQL Editor
-- This script bypasses the system role protection trigger

DO $$
DECLARE
  tenant_uuid UUID := '39dd5564-073f-4902-a24b-23037cf9d178';
  org_ids UUID[];
  member_ids UUID[];
  role_ids UUID[];
  tenant_user_ids UUID[];
BEGIN
  -- Verify tenant exists
  IF NOT EXISTS (SELECT 1 FROM tenant WHERE id::text = tenant_uuid::text) THEN
    RAISE EXCEPTION 'Tenant not found: %', tenant_uuid;
  END IF;
  
  RAISE NOTICE 'Starting deletion of tenant: %', tenant_uuid;
  
  -- Get organization IDs
  SELECT ARRAY_AGG(id::uuid) INTO org_ids 
  FROM organization 
  WHERE tenant_id::text = tenant_uuid::text;
  
  RAISE NOTICE 'Found % organizations', COALESCE(array_length(org_ids, 1), 0);
  
  -- Get member IDs via organizations
  IF org_ids IS NOT NULL AND array_length(org_ids, 1) > 0 THEN
    SELECT ARRAY_AGG(id::uuid) INTO member_ids 
    FROM member 
    WHERE organization_id::text = ANY(SELECT unnest(org_ids)::text);
    
    RAISE NOTICE 'Found % members', COALESCE(array_length(member_ids, 1), 0);
    
    -- Delete member_credentials
    IF member_ids IS NOT NULL AND array_length(member_ids, 1) > 0 THEN
      DELETE FROM member_credentials WHERE member_id::text = ANY(SELECT unnest(member_ids)::text);
      RAISE NOTICE 'Deleted member_credentials';
      
      -- Delete members
      DELETE FROM member WHERE id::text = ANY(SELECT unnest(member_ids)::text);
      RAISE NOTICE 'Deleted members';
    END IF;
  END IF;
  
  -- Get tenant_user IDs
  SELECT ARRAY_AGG(id::uuid) INTO tenant_user_ids 
  FROM tenant_user 
  WHERE tenant_id::text = tenant_uuid::text;
  
  -- Delete tenant_user_member_link
  DELETE FROM tenant_user_member_link WHERE tenant_id::text = tenant_uuid::text;
  RAISE NOTICE 'Deleted tenant_user_member_link';
  
  -- Delete tenant_user_credentials
  IF tenant_user_ids IS NOT NULL AND array_length(tenant_user_ids, 1) > 0 THEN
    DELETE FROM tenant_user_credentials WHERE tenant_user_id::text = ANY(SELECT unnest(tenant_user_ids)::text);
    RAISE NOTICE 'Deleted tenant_user_credentials';
  END IF;
  
  -- Delete tenant_users
  DELETE FROM tenant_user WHERE tenant_id::text = tenant_uuid::text;
  RAISE NOTICE 'Deleted tenant_users';
  
  -- Get role IDs
  SELECT ARRAY_AGG(id::uuid) INTO role_ids 
  FROM role 
  WHERE tenant_id::text = tenant_uuid::text;
  
  -- Delete role field permissions
  IF role_ids IS NOT NULL AND array_length(role_ids, 1) > 0 THEN
    DELETE FROM role_member_field_permission WHERE role_id::text = ANY(SELECT unnest(role_ids)::text);
    DELETE FROM role_organization_field_permission WHERE role_id::text = ANY(SELECT unnest(role_ids)::text);
    RAISE NOTICE 'Deleted role field permissions';
  END IF;
  
  -- Temporarily disable the system role protection trigger
  ALTER TABLE role DISABLE TRIGGER protect_system_roles;
  
  -- Delete roles
  DELETE FROM role WHERE tenant_id::text = tenant_uuid::text;
  RAISE NOTICE 'Deleted roles';
  
  -- Re-enable the trigger
  ALTER TABLE role ENABLE TRIGGER protect_system_roles;
  
  -- Delete organizations
  DELETE FROM organization WHERE tenant_id::text = tenant_uuid::text;
  RAISE NOTICE 'Deleted organizations';
  
  -- Delete the tenant
  DELETE FROM tenant WHERE id::text = tenant_uuid::text;
  RAISE NOTICE 'Successfully deleted tenant: %', tenant_uuid;
  
END $$;

-- Verify deletion
SELECT 'Remaining tenants:' as info, COUNT(*) as count FROM tenant;
