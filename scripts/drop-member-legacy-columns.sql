-- Drop deprecated member columns: last_synced, last_login, has_seen_onboarding_tour
-- last_synced: Was used for Zoho CRM sync, now fully removed
-- last_login: Superseded by last_activity which better tracks member engagement
-- has_seen_onboarding_tour: Superseded by page_tours_seen which tracks per-page tours
-- 
-- Run this in Supabase SQL Editor after confirming these columns are no longer needed

-- Drop last_synced column from member table
ALTER TABLE member DROP COLUMN IF EXISTS last_synced;

-- Drop last_login column from member table  
ALTER TABLE member DROP COLUMN IF EXISTS last_login;

-- Drop has_seen_onboarding_tour column from member table
ALTER TABLE member DROP COLUMN IF EXISTS has_seen_onboarding_tour;

-- Verify the columns are dropped
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'member' 
AND column_name IN ('last_synced', 'last_login', 'has_seen_onboarding_tour');
-- Should return 0 rows if columns were successfully dropped
