-- Database Column Audit Query
-- Run this in Supabase SQL Editor to get a list of all columns
-- Then we can cross-reference against the codebase to find unused columns

-- List all columns in public schema, grouped by table
SELECT 
    table_name,
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

-- Alternative: Get columns that might be legacy (containing specific patterns)
-- Uncomment to run:
/*
SELECT 
    table_name,
    column_name,
    data_type
FROM information_schema.columns 
WHERE table_schema = 'public'
AND (
    column_name LIKE '%base44%'
    OR column_name LIKE '%legacy%'
    OR column_name LIKE '%old_%'
    OR column_name LIKE '%deprecated%'
    OR column_name LIKE '%temp_%'
)
ORDER BY table_name, column_name;
*/
