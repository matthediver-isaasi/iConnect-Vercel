-- Drop deprecated member columns: last_synced and last_login
-- last_synced: Was used for Zoho CRM sync, now fully removed
-- last_login: Superseded by last_activity which better tracks member engagement
-- 
-- Run this in Supabase SQL Editor after confirming these columns are no longer needed

-- Drop last_synced column from member table
ALTER TABLE member DROP COLUMN IF EXISTS last_synced;

-- Drop last_login column from member table  
ALTER TABLE member DROP COLUMN IF EXISTS last_login;

-- Verify the columns are dropped
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'member' 
AND column_name IN ('last_synced', 'last_login');
-- Should return 0 rows if columns were successfully dropped
