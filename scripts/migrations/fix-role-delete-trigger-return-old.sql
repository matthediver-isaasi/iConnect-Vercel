-- Migration: Fix role deletion trigger to return OLD for DELETE operations
-- 
-- Problem: The prevent_system_role_modification() trigger function ends with
-- RETURN NEW, but in a BEFORE DELETE context NEW is NULL. When a BEFORE trigger
-- returns NULL, PostgreSQL silently cancels the row operation. This means every
-- non-system role delete is silently swallowed.
--
-- Fix: Return OLD for DELETE operations (to allow the delete to proceed) and
-- NEW for UPDATE operations.
--
-- Run this SQL in your Supabase SQL Editor

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

  -- Return OLD for DELETE (allows the delete to proceed)
  -- Return NEW for UPDATE (allows the update to proceed, possibly with modified values)
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;
