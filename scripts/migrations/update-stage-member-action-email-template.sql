-- Migration: Update stage_member_action to use email template instead of boolean
-- This adds welcome_email_template_id column and removes send_welcome_email
-- Safe to run on both new and existing databases

-- Step 1: Add welcome_email_template_id column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'stage_member_action' 
    AND column_name = 'welcome_email_template_id'
  ) THEN
    ALTER TABLE stage_member_action 
    ADD COLUMN welcome_email_template_id UUID REFERENCES email_template(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Step 2: Drop send_welcome_email column if it exists (optional - safe migration)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'stage_member_action' 
    AND column_name = 'send_welcome_email'
  ) THEN
    ALTER TABLE stage_member_action DROP COLUMN send_welcome_email;
  END IF;
END $$;

-- Verify migration
SELECT 
  column_name,
  data_type
FROM information_schema.columns 
WHERE table_name = 'stage_member_action'
ORDER BY ordinal_position;
