-- Migration: Add tenant_id to tour_group and tour_step tables
-- This enables multi-tenant isolation for tour configurations
-- 
-- IMPORTANT: Run this migration BEFORE deploying the scope change code
-- to prevent tours from disappearing during rollout.
--
-- DEPLOYMENT ORDER:
-- 1. Run Steps 1-5 on the database
-- 2. Verify with Step 6 queries
-- 3. Deploy the code change (tenantContext.js scope update)
-- 4. Run Steps 7-8 to add constraints

-- ============================================================
-- Step 1: Add tenant_id column to tour_group
-- ============================================================
ALTER TABLE tour_group ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- ============================================================
-- Step 2: Add tenant_id column to tour_step  
-- ============================================================
ALTER TABLE tour_step ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- ============================================================
-- Step 3: Create indexes for efficient tenant-scoped queries
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_tour_group_tenant_id ON tour_group(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tour_step_tenant_id ON tour_step(tenant_id);

-- ============================================================
-- Step 4: Backfill tour_group with tenant assignment
-- 
-- OPTION A: Single-tenant (GFI only) - DEFAULT
-- Assigns all existing tours to the GFI tenant
-- ============================================================
DO $$
DECLARE
  gfi_tenant_id UUID;
BEGIN
  -- Get the GFI tenant ID
  SELECT id INTO gfi_tenant_id FROM tenant WHERE subdomain = 'gfi' LIMIT 1;
  
  IF gfi_tenant_id IS NULL THEN
    RAISE NOTICE 'WARNING: No tenant found with subdomain "gfi". Checking for any existing tenant...';
    SELECT id INTO gfi_tenant_id FROM tenant LIMIT 1;
    
    IF gfi_tenant_id IS NULL THEN
      RAISE EXCEPTION 'ERROR: No tenants found in database. Please create a tenant first.';
    ELSE
      RAISE NOTICE 'Using first available tenant: %', gfi_tenant_id;
    END IF;
  END IF;
  
  -- Backfill tour_group
  UPDATE tour_group SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  RAISE NOTICE 'Updated % tour_group rows with tenant_id %', (SELECT COUNT(*) FROM tour_group WHERE tenant_id = gfi_tenant_id), gfi_tenant_id;
END $$;

-- OPTION B: Multi-tenant environment (MANUAL - uncomment and run per tenant)
-- If tours should exist in multiple tenants, run separate updates for each:
--
-- For tenant 'tenant-a':
-- UPDATE tour_group SET tenant_id = (SELECT id FROM tenant WHERE subdomain = 'tenant-a') 
-- WHERE name LIKE '%tenant-a%' AND tenant_id IS NULL;
--
-- For tenant 'tenant-b':
-- UPDATE tour_group SET tenant_id = (SELECT id FROM tenant WHERE subdomain = 'tenant-b') 
-- WHERE name LIKE '%tenant-b%' AND tenant_id IS NULL;

-- ============================================================
-- Step 5: Backfill tour_step by inheriting tenant_id from parent tour_group
-- This ensures tour steps are always in the same tenant as their parent group
-- ============================================================
UPDATE tour_step ts
SET tenant_id = tg.tenant_id
FROM tour_group tg
WHERE ts.tour_group_id = tg.id
AND ts.tenant_id IS NULL;

-- ============================================================
-- Step 6: Verify the backfill (run these queries manually)
-- Both should return 0 before proceeding
-- ============================================================
-- SELECT COUNT(*) as tour_groups_without_tenant FROM tour_group WHERE tenant_id IS NULL;
-- SELECT COUNT(*) as tour_steps_without_tenant FROM tour_step WHERE tenant_id IS NULL;
-- SELECT tg.name, tg.tenant_id, t.subdomain FROM tour_group tg LEFT JOIN tenant t ON tg.tenant_id = t.id;

-- ============================================================
-- Step 7: After verification, add NOT NULL constraints
-- Run these AFTER confirming all rows have tenant_id populated
-- ============================================================
-- ALTER TABLE tour_group ALTER COLUMN tenant_id SET NOT NULL;
-- ALTER TABLE tour_step ALTER COLUMN tenant_id SET NOT NULL;

-- ============================================================
-- Step 8: Add foreign key constraints for referential integrity
-- ============================================================
-- ALTER TABLE tour_group ADD CONSTRAINT fk_tour_group_tenant 
--   FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE;
-- ALTER TABLE tour_step ADD CONSTRAINT fk_tour_step_tenant 
--   FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE;
