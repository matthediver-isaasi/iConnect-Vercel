-- Drop Zoho-related columns and tables
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

  -- Drop zoho_contact_id from organization_contact table
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_contact') THEN
    ALTER TABLE organization_contact DROP COLUMN IF EXISTS zoho_contact_id;
    RAISE NOTICE 'Dropped zoho_contact_id from organization_contact table';
  END IF;

  -- Drop the zoho_token table entirely
  DROP TABLE IF EXISTS zoho_token;
  RAISE NOTICE 'Dropped zoho_token table';

  RAISE NOTICE 'Zoho cleanup completed successfully!';
END $$;
