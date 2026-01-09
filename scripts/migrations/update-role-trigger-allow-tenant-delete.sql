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

-- Create a helper function that sets the bypass flag and can be called from the app
CREATE OR REPLACE FUNCTION enable_tenant_deletion_mode()
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.allow_tenant_deletion', 'true', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create a helper function to disable the bypass
CREATE OR REPLACE FUNCTION disable_tenant_deletion_mode()
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.allow_tenant_deletion', 'false', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
