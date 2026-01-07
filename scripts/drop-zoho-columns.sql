-- Drop Zoho-related columns from organization and member tables
-- Run this script in your Supabase SQL Editor
-- Generated: January 2026

DO $$ 
BEGIN
  -- Drop zoho_account_id from organization table
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization') THEN
    DROP INDEX IF EXISTS idx_organization_zoho_account_id;
    ALTER TABLE organization DROP COLUMN IF EXISTS zoho_account_id;
    RAISE NOTICE 'Dropped zoho_account_id from organization table';
  END IF;

  -- Drop zoho_contact_id from member table
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member') THEN
    DROP INDEX IF EXISTS idx_member_zoho_contact_id;
    ALTER TABLE member DROP COLUMN IF EXISTS zoho_contact_id;
    RAISE NOTICE 'Dropped zoho_contact_id from member table';
  END IF;

  RAISE NOTICE 'Zoho columns dropped successfully!';
END $$;
