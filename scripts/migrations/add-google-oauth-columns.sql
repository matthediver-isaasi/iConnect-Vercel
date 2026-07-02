-- Add Google OAuth columns to member and tenant_user tables
-- Run this in Supabase SQL Editor

-- Add google_id to member table for linking Google accounts
ALTER TABLE member 
ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;

-- Create index for fast Google ID lookups
CREATE INDEX IF NOT EXISTS idx_member_google_id ON member(google_id) WHERE google_id IS NOT NULL;

-- Add google_id to tenant_user table for linking Google accounts  
ALTER TABLE tenant_user 
ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;

-- Create index for fast Google ID lookups
CREATE INDEX IF NOT EXISTS idx_tenant_user_google_id ON tenant_user(google_id) WHERE google_id IS NOT NULL;

-- Verify the columns were added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'member' AND column_name = 'google_id';

SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'tenant_user' AND column_name = 'google_id';
