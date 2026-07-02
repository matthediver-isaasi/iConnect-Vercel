-- Add allowed_role_ids column to dynamic_directory table
-- Run this in Supabase SQL Editor

ALTER TABLE dynamic_directory 
ADD COLUMN IF NOT EXISTS allowed_role_ids text[] DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN dynamic_directory.allowed_role_ids IS 'Array of role IDs allowed to view this directory. NULL means all roles can view.';
