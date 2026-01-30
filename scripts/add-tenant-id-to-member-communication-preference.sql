-- Migration: Add tenant_id column to member_communication_preference table
-- This is required because the entity was changed to TENANT scope to allow admins to view all member preferences
-- The tenant_id will be derived from the member's tenant_id

-- Step 1: Add the tenant_id column (nullable initially)
ALTER TABLE member_communication_preference 
ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Step 2: Populate tenant_id from the related member's tenant_id
UPDATE member_communication_preference mcp
SET tenant_id = m.tenant_id
FROM member m
WHERE mcp.member_id = m.id
AND mcp.tenant_id IS NULL;

-- Step 3: Make the column NOT NULL after populating
ALTER TABLE member_communication_preference 
ALTER COLUMN tenant_id SET NOT NULL;

-- Step 4: Add an index for better query performance
CREATE INDEX IF NOT EXISTS idx_member_communication_preference_tenant_id 
ON member_communication_preference(tenant_id);

-- Step 5: Add foreign key constraint to tenant table
ALTER TABLE member_communication_preference
ADD CONSTRAINT fk_member_communication_preference_tenant
FOREIGN KEY (tenant_id) REFERENCES tenant(id)
ON DELETE CASCADE;
