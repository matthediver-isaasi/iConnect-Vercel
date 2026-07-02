-- Add unique constraint on member email (case-insensitive)
-- This prevents duplicate members with the same email regardless of case

-- First, verify there are no remaining conflicts
-- Run this query to check before applying the index:
-- SELECT lower(trim(email)) as email_lower, count(*) 
-- FROM member 
-- WHERE email IS NOT NULL AND trim(email) != ''
-- GROUP BY lower(trim(email)) 
-- HAVING count(*) > 1;

-- Create a partial unique index on lowercase trimmed email
-- This allows NULL and empty emails while enforcing uniqueness on actual emails
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS member_email_unique_ci_idx 
ON public.member (lower(trim(email))) 
WHERE email IS NOT NULL AND trim(email) != '';

-- Note: If you have a deleted_at column for soft deletes, add this condition:
-- WHERE email IS NOT NULL AND trim(email) != '' AND deleted_at IS NULL;

-- To drop this index if needed:
-- DROP INDEX IF EXISTS member_email_unique_ci_idx;
