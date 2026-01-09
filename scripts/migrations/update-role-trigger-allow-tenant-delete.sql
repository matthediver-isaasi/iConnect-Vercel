-- Migration: Update system role protection trigger to allow bypass during tenant deletion
-- Run this SQL in your Supabase SQL Editor

-- Update the trigger function to check for a session variable that allows bypass
CREATE OR REPLACE FUNCTION prevent_system_role_modification()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if tenant deletion bypass is enabled
  -- This allows platform admins to delete entire tenants including their system roles
  IF current_setting('app.allow_tenant_deletion', true) = 'true' THEN
    RETURN OLD;
  END IF;

  -- Prevent deletion of system roles
  IF TG_OP = 'DELETE' AND OLD.is_system = true THEN
    RAISE EXCEPTION 'Cannot delete system role: %', OLD.name;
  END IF;
  
  -- Prevent renaming system roles
  IF TG_OP = 'UPDATE' AND OLD.is_system = true THEN
    IF NEW.name != OLD.name THEN
      RAISE EXCEPTION 'Cannot rename system role: %', OLD.name;
    END IF;
    -- Prevent removing is_system flag
    IF NEW.is_system = false OR NEW.is_system IS NULL THEN
      NEW.is_system := true;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create a function that deletes all roles for a tenant, bypassing the trigger
-- This runs in a single transaction with the bypass enabled
CREATE OR REPLACE FUNCTION delete_tenant_roles(p_tenant_id UUID)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Set the bypass flag for this transaction
  PERFORM set_config('app.allow_tenant_deletion', 'true', true);
  
  -- Delete all roles for the tenant
  DELETE FROM role WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create a function that deletes the tenant record itself
CREATE OR REPLACE FUNCTION delete_tenant_record(p_tenant_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  DELETE FROM tenant WHERE id = p_tenant_id;
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
