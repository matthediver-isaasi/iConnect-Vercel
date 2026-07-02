-- Migration: Simplified tenant deletion with trigger control
-- Run this in Supabase SQL Editor

-- Step 1: Create helper functions to disable/enable the trigger
-- These are SECURITY DEFINER so they run with owner privileges

CREATE OR REPLACE FUNCTION disable_role_protection_trigger()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  ALTER TABLE role DISABLE TRIGGER protect_system_roles;
END;
$$;

CREATE OR REPLACE FUNCTION enable_role_protection_trigger()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  ALTER TABLE role ENABLE TRIGGER protect_system_roles;
END;
$$;

-- Grant execute to service_role only
REVOKE ALL ON FUNCTION disable_role_protection_trigger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION disable_role_protection_trigger() TO service_role;

REVOKE ALL ON FUNCTION enable_role_protection_trigger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enable_role_protection_trigger() TO service_role;

-- Clean up old functions if they exist
DROP FUNCTION IF EXISTS platform_delete_tenant(UUID);
DROP FUNCTION IF EXISTS platform_delete_tenant(TEXT);
