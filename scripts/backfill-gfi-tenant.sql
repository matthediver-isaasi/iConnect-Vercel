-- Backfill script for Graduate Futures Institute tenant
-- Run this in Supabase SQL Editor
-- This script:
--   1. Creates the GFI tenant record
--   2. Backfills all existing data to belong to that tenant (safely skips missing tables)
--   3. Creates a tenant_user for mat@isaasi.co.uk

-- ============================================
-- STEP 1: Create the GFI tenant
-- ============================================
INSERT INTO tenant (
  id,
  name,
  slug,
  domain,
  status,
  subscription_plan,
  subscription_status
) VALUES (
  gen_random_uuid(),
  'Graduate Futures Institute',
  'gfi',
  'gfi.iconn.app',
  'active',
  'enterprise',
  'active'
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  domain = EXCLUDED.domain,
  status = EXCLUDED.status;

-- ============================================
-- STEP 2: Backfill tenant_id on all tables
-- ============================================
-- Helper function to safely update tenant_id only if table exists
CREATE OR REPLACE FUNCTION safe_update_tenant_id(table_name TEXT, tid UUID)
RETURNS VOID AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND information_schema.tables.table_name = safe_update_tenant_id.table_name
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND information_schema.columns.table_name = safe_update_tenant_id.table_name 
      AND column_name = 'tenant_id'
    ) THEN
      EXECUTE format('UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL', table_name) USING tid;
      RAISE NOTICE 'Updated %', table_name;
    ELSE
      RAISE NOTICE 'Table % exists but has no tenant_id column - skipped', table_name;
    END IF;
  ELSE
    RAISE NOTICE 'Table % does not exist - skipped', table_name;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Get the GFI tenant ID and update all tables
DO $$
DECLARE
  gfi_tenant_id UUID;
BEGIN
  SELECT id INTO gfi_tenant_id FROM tenant WHERE slug = 'gfi';
  
  IF gfi_tenant_id IS NULL THEN
    RAISE EXCEPTION 'GFI tenant not found. Ensure Step 1 completed.';
  END IF;
  
  RAISE NOTICE 'Backfilling with GFI tenant_id: %', gfi_tenant_id;
  
  -- Core tables
  PERFORM safe_update_tenant_id('organization', gfi_tenant_id);
  PERFORM safe_update_tenant_id('role', gfi_tenant_id);
  PERFORM safe_update_tenant_id('event', gfi_tenant_id);
  PERFORM safe_update_tenant_id('program', gfi_tenant_id);
  PERFORM safe_update_tenant_id('form', gfi_tenant_id);
  PERFORM safe_update_tenant_id('form_submission', gfi_tenant_id);
  PERFORM safe_update_tenant_id('booking', gfi_tenant_id);
  PERFORM safe_update_tenant_id('voucher', gfi_tenant_id);
  PERFORM safe_update_tenant_id('discount_code', gfi_tenant_id);
  PERFORM safe_update_tenant_id('job_posting', gfi_tenant_id);
  PERFORM safe_update_tenant_id('resource', gfi_tenant_id);
  PERFORM safe_update_tenant_id('resource_category', gfi_tenant_id);
  PERFORM safe_update_tenant_id('resource_folder', gfi_tenant_id);
  PERFORM safe_update_tenant_id('blog_post', gfi_tenant_id);
  PERFORM safe_update_tenant_id('news_post', gfi_tenant_id);
  PERFORM safe_update_tenant_id('navigation_item', gfi_tenant_id);
  PERFORM safe_update_tenant_id('portal_navigation_item', gfi_tenant_id);
  PERFORM safe_update_tenant_id('portal_menu', gfi_tenant_id);
  PERFORM safe_update_tenant_id('page_banner', gfi_tenant_id);
  PERFORM safe_update_tenant_id('floater', gfi_tenant_id);
  PERFORM safe_update_tenant_id('support_ticket', gfi_tenant_id);
  PERFORM safe_update_tenant_id('workflow', gfi_tenant_id);
  PERFORM safe_update_tenant_id('award', gfi_tenant_id);
  PERFORM safe_update_tenant_id('offline_award', gfi_tenant_id);
  PERFORM safe_update_tenant_id('wall_of_fame_section', gfi_tenant_id);
  PERFORM safe_update_tenant_id('wall_of_fame_category', gfi_tenant_id);
  PERFORM safe_update_tenant_id('wall_of_fame_person', gfi_tenant_id);
  PERFORM safe_update_tenant_id('member_group', gfi_tenant_id);
  PERFORM safe_update_tenant_id('file_repository', gfi_tenant_id);
  PERFORM safe_update_tenant_id('file_repository_folder', gfi_tenant_id);
  PERFORM safe_update_tenant_id('team_member', gfi_tenant_id);
  PERFORM safe_update_tenant_id('speaker', gfi_tenant_id);
  PERFORM safe_update_tenant_id('card_deck', gfi_tenant_id);
  PERFORM safe_update_tenant_id('dynamic_directory', gfi_tenant_id);
  PERFORM safe_update_tenant_id('i_edit_page', gfi_tenant_id);
  PERFORM safe_update_tenant_id('i_edit_page_element', gfi_tenant_id);
  PERFORM safe_update_tenant_id('program_ticket_transaction', gfi_tenant_id);
  PERFORM safe_update_tenant_id('training_fund_transaction', gfi_tenant_id);
  PERFORM safe_update_tenant_id('voucher_transaction', gfi_tenant_id);
  PERFORM safe_update_tenant_id('discount_code_usage', gfi_tenant_id);
  PERFORM safe_update_tenant_id('email_template', gfi_tenant_id);
  PERFORM safe_update_tenant_id('resource_author_settings', gfi_tenant_id);
  PERFORM safe_update_tenant_id('article_category', gfi_tenant_id);
  PERFORM safe_update_tenant_id('offline_award_assignment', gfi_tenant_id);
  PERFORM safe_update_tenant_id('engagement_award', gfi_tenant_id);
  PERFORM safe_update_tenant_id('engagement_award_assignment', gfi_tenant_id);
  PERFORM safe_update_tenant_id('organisation_award', gfi_tenant_id);
  PERFORM safe_update_tenant_id('organisation_award_assignment', gfi_tenant_id);
  PERFORM safe_update_tenant_id('member_group_assignment', gfi_tenant_id);
  PERFORM safe_update_tenant_id('member_group_guest', gfi_tenant_id);
  PERFORM safe_update_tenant_id('support_ticket_response', gfi_tenant_id);
  PERFORM safe_update_tenant_id('workflow_log', gfi_tenant_id);
  PERFORM safe_update_tenant_id('communication_category', gfi_tenant_id);
  PERFORM safe_update_tenant_id('communication_category_role', gfi_tenant_id);
  PERFORM safe_update_tenant_id('page_visibility', gfi_tenant_id);
  PERFORM safe_update_tenant_id('xero_token', gfi_tenant_id);
  PERFORM safe_update_tenant_id('guest_writer', gfi_tenant_id);
  
  RAISE NOTICE 'Backfill complete!';
END $$;

-- Clean up helper function
DROP FUNCTION IF EXISTS safe_update_tenant_id(TEXT, UUID);

-- ============================================
-- STEP 3: Create tenant_user for mat@isaasi.co.uk
-- ============================================
DO $$
DECLARE
  gfi_tenant_id UUID;
  mat_member_id UUID;
  mat_password_hash VARCHAR;
  new_tenant_user_id UUID;
BEGIN
  SELECT id INTO gfi_tenant_id FROM tenant WHERE slug = 'gfi';
  
  IF gfi_tenant_id IS NULL THEN
    RAISE EXCEPTION 'GFI tenant not found';
  END IF;
  
  SELECT m.id INTO mat_member_id
  FROM member m
  WHERE m.email = 'mat@isaasi.co.uk'
  LIMIT 1;
  
  IF mat_member_id IS NULL THEN
    RAISE NOTICE 'Member mat@isaasi.co.uk not found - skipping tenant_user creation';
    RETURN;
  END IF;
  
  SELECT mc.password_hash INTO mat_password_hash
  FROM member_credentials mc
  WHERE mc.member_id::text = mat_member_id::text
  LIMIT 1;
  
  IF mat_password_hash IS NULL THEN
    RAISE NOTICE 'No credentials found for mat@isaasi.co.uk - skipping tenant_user creation';
    RETURN;
  END IF;
  
  INSERT INTO tenant_user (
    id,
    tenant_id,
    email,
    first_name,
    last_name,
    role,
    status
  )
  SELECT
    gen_random_uuid(),
    gfi_tenant_id,
    'mat@isaasi.co.uk',
    m.first_name,
    m.last_name,
    'owner',
    'active'
  FROM member m
  WHERE m.id = mat_member_id
  ON CONFLICT (tenant_id, email) DO NOTHING
  RETURNING id INTO new_tenant_user_id;
  
  IF new_tenant_user_id IS NOT NULL THEN
    INSERT INTO tenant_user_credentials (
      id,
      tenant_user_id,
      email,
      password_hash,
      is_temporary
    ) VALUES (
      gen_random_uuid(),
      new_tenant_user_id,
      'mat@isaasi.co.uk',
      mat_password_hash,
      false
    )
    ON CONFLICT (email) DO NOTHING;
    
    RAISE NOTICE 'Created tenant_user for mat@isaasi.co.uk with ID: %', new_tenant_user_id;
  ELSE
    RAISE NOTICE 'tenant_user for mat@isaasi.co.uk already exists';
  END IF;
END $$;

-- ============================================
-- Verification queries
-- ============================================
SELECT id, name, slug, domain, status FROM tenant WHERE slug = 'gfi';

SELECT COUNT(*) as org_count, tenant_id FROM organization GROUP BY tenant_id;

SELECT tu.id, tu.email, tu.role, tu.status, t.name as tenant_name
FROM tenant_user tu
JOIN tenant t ON t.id = tu.tenant_id
WHERE tu.email = 'mat@isaasi.co.uk';
