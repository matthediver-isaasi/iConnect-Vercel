-- Migration: Add unique constraint on member(email, tenant_id) for duplicate prevention
-- This ensures email addresses are unique within a tenant across all organizations
-- The constraint also prevents race conditions when multiple member creation actions run concurrently

-- Step 1: Add unique constraint on (email, tenant_id) combination
-- Note: This will fail if there are existing duplicate emails within a tenant
-- If duplicates exist, they must be cleaned up manually first

-- First check for existing duplicates (for debugging purposes)
-- SELECT email, tenant_id, COUNT(*) as count 
-- FROM member 
-- GROUP BY email, tenant_id 
-- HAVING COUNT(*) > 1;

-- Add the unique constraint
ALTER TABLE member 
ADD CONSTRAINT member_email_tenant_unique UNIQUE (email, tenant_id);

-- Verify the constraint was added
SELECT 
  conname as constraint_name,
  contype as constraint_type
FROM pg_constraint 
WHERE conname = 'member_email_tenant_unique';
