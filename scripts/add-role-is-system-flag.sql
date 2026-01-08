-- Migration: Add is_system flag to role table for protecting system roles
-- Run this SQL in your Supabase SQL Editor

-- Add is_system column to role table
ALTER TABLE role ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT false;

-- Backfill: Mark Super Admin and Administrator roles as system roles
UPDATE role
SET is_system = true
WHERE name IN ('Super Admin', 'Administrator');

-- Also rename Administrator to Super Admin for consistency
UPDATE role
SET name = 'Super Admin'
WHERE name = 'Administrator';

-- Verify the update
SELECT id, name, tenant_id, is_system, is_default
FROM role
WHERE is_system = true;

-- Create index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_role_is_system ON role(is_system) WHERE is_system = true;

-- Create a trigger function to prevent deletion of system roles
CREATE OR REPLACE FUNCTION prevent_system_role_modification()
RETURNS TRIGGER AS $$
BEGIN
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

-- Drop the trigger if it exists and recreate it
DROP TRIGGER IF EXISTS protect_system_roles ON role;
CREATE TRIGGER protect_system_roles
  BEFORE UPDATE OR DELETE ON role
  FOR EACH ROW
  EXECUTE FUNCTION prevent_system_role_modification();
