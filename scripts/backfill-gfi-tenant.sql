-- Backfill script for Graduate Futures Institute tenant
-- Run this in Supabase SQL Editor
-- This script:
--   1. Creates the GFI tenant record
--   2. Backfills all existing data to belong to that tenant
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
-- Get the GFI tenant ID for the updates
DO $$
DECLARE
  gfi_tenant_id UUID;
BEGIN
  SELECT id INTO gfi_tenant_id FROM tenant WHERE slug = 'gfi';
  
  IF gfi_tenant_id IS NULL THEN
    RAISE EXCEPTION 'GFI tenant not found. Ensure Step 1 completed.';
  END IF;
  
  -- Update organization
  UPDATE organization SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update role
  UPDATE role SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update event
  UPDATE event SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update program
  UPDATE program SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update form
  UPDATE form SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update form_submission
  UPDATE form_submission SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update booking
  UPDATE booking SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update voucher
  UPDATE voucher SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update discount_code
  UPDATE discount_code SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update job_posting
  UPDATE job_posting SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update resource
  UPDATE resource SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update resource_category
  UPDATE resource_category SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update resource_folder
  UPDATE resource_folder SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update blog_post
  UPDATE blog_post SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update news_post
  UPDATE news_post SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update navigation_item
  UPDATE navigation_item SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update portal_navigation_item
  UPDATE portal_navigation_item SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update portal_menu
  UPDATE portal_menu SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update page_banner
  UPDATE page_banner SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update floater
  UPDATE floater SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update support_ticket
  UPDATE support_ticket SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update workflow
  UPDATE workflow SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update award
  UPDATE award SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update offline_award
  UPDATE offline_award SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update wall_of_fame_section
  UPDATE wall_of_fame_section SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update wall_of_fame_category
  UPDATE wall_of_fame_category SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update wall_of_fame_person
  UPDATE wall_of_fame_person SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update member_group
  UPDATE member_group SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update file_repository
  UPDATE file_repository SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update file_repository_folder
  UPDATE file_repository_folder SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update team_member
  UPDATE team_member SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update speaker
  UPDATE speaker SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update card_deck
  UPDATE card_deck SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update dynamic_directory
  UPDATE dynamic_directory SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update i_edit_page
  UPDATE i_edit_page SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update i_edit_page_element
  UPDATE i_edit_page_element SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update program_ticket_transaction
  UPDATE program_ticket_transaction SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update training_fund_transaction
  UPDATE training_fund_transaction SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update voucher_transaction
  UPDATE voucher_transaction SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update discount_code_usage
  UPDATE discount_code_usage SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update email_template
  UPDATE email_template SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update resource_author_settings
  UPDATE resource_author_settings SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update article_category
  UPDATE article_category SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update offline_award_assignment
  UPDATE offline_award_assignment SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update engagement_award
  UPDATE engagement_award SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update engagement_award_assignment
  UPDATE engagement_award_assignment SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update organisation_award
  UPDATE organisation_award SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update organisation_award_assignment
  UPDATE organisation_award_assignment SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update member_group_assignment
  UPDATE member_group_assignment SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update member_group_guest
  UPDATE member_group_guest SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update support_ticket_response
  UPDATE support_ticket_response SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update workflow_log
  UPDATE workflow_log SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update communication_category
  UPDATE communication_category SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update communication_category_role
  UPDATE communication_category_role SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update page_visibility
  UPDATE page_visibility SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update xero_token
  UPDATE xero_token SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  -- Update guest_writer
  UPDATE guest_writer SET tenant_id = gfi_tenant_id WHERE tenant_id IS NULL;
  
  RAISE NOTICE 'Backfill complete. GFI tenant_id: %', gfi_tenant_id;
END $$;

-- ============================================
-- STEP 3: Create tenant_user for mat@isaasi.co.uk
-- ============================================
-- This creates a tenant_user linked to the GFI tenant, reusing the
-- password hash from their existing member_credentials for convenience.
DO $$
DECLARE
  gfi_tenant_id UUID;
  mat_member_id UUID;
  mat_password_hash VARCHAR;
  new_tenant_user_id UUID;
BEGIN
  -- Get GFI tenant
  SELECT id INTO gfi_tenant_id FROM tenant WHERE slug = 'gfi';
  
  IF gfi_tenant_id IS NULL THEN
    RAISE EXCEPTION 'GFI tenant not found';
  END IF;
  
  -- Get Mat's member and credentials
  SELECT m.id INTO mat_member_id
  FROM member m
  WHERE m.email = 'mat@isaasi.co.uk'
  LIMIT 1;
  
  IF mat_member_id IS NULL THEN
    RAISE NOTICE 'Member mat@isaasi.co.uk not found - skipping tenant_user creation';
    RETURN;
  END IF;
  
  -- Get the password hash from member_credentials
  -- Note: member_credentials.member_id may be UUID or VARCHAR depending on migration history
  -- Try direct comparison first (works if both are UUID)
  SELECT mc.password_hash INTO mat_password_hash
  FROM member_credentials mc
  WHERE mc.member_id::text = mat_member_id::text
  LIMIT 1;
  
  IF mat_password_hash IS NULL THEN
    RAISE NOTICE 'No credentials found for mat@isaasi.co.uk - skipping tenant_user creation';
    RETURN;
  END IF;
  
  -- Create tenant_user if not exists
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
  
  -- If inserted, create credentials
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
-- Run these to verify the backfill worked:

-- Check tenant record
SELECT id, name, slug, domain, status FROM tenant WHERE slug = 'gfi';

-- Check organizations are linked
SELECT COUNT(*) as org_count, tenant_id FROM organization GROUP BY tenant_id;

-- Check tenant_user was created
SELECT tu.id, tu.email, tu.role, tu.status, t.name as tenant_name
FROM tenant_user tu
JOIN tenant t ON t.id = tu.tenant_id
WHERE tu.email = 'mat@isaasi.co.uk';
