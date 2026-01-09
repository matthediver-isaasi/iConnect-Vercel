-- Migration: Create platform_delete_tenant function for safe tenant deletion
-- This function bypasses the system role protection trigger during full tenant teardown
-- Run this SQL in Supabase SQL Editor

-- Step 1: Update the trigger to check for a bypass flag (preserve DELETE protection)
CREATE OR REPLACE FUNCTION prevent_system_role_modification()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if tenant deletion bypass is enabled for this transaction
  IF current_setting('app.allow_tenant_deletion', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  -- Prevent deletion of system roles (normal operations)
  IF TG_OP = 'DELETE' AND OLD.is_system = true THEN
    RAISE EXCEPTION 'Cannot delete system role: %', OLD.name;
  END IF;
  
  -- Prevent renaming system roles
  IF TG_OP = 'UPDATE' AND OLD.is_system = true THEN
    IF NEW.name != OLD.name THEN
      RAISE EXCEPTION 'Cannot rename system role: %', OLD.name;
    END IF;
    -- Prevent removing is_system flag
    IF NEW.is_system = false OR NEW.is_system IS NULL THEN
      NEW.is_system := true;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure trigger exists for both UPDATE and DELETE
DROP TRIGGER IF EXISTS protect_system_roles ON role;
CREATE TRIGGER protect_system_roles
  BEFORE UPDATE OR DELETE ON role
  FOR EACH ROW
  EXECUTE FUNCTION prevent_system_role_modification();

-- Step 2: Create the tenant deletion function
-- This runs as the function owner (postgres) and sets the bypass flag
CREATE OR REPLACE FUNCTION platform_delete_tenant(p_tenant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB := '{}'::JSONB;
  v_count INTEGER;
  v_tenant_record RECORD;
BEGIN
  -- Validate tenant exists
  SELECT id, name, slug INTO v_tenant_record
  FROM tenant WHERE id = p_tenant_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tenant not found');
  END IF;

  -- Enable bypass flag for this transaction
  PERFORM set_config('app.allow_tenant_deletion', 'true', true);

  -- Delete in FK-safe order
  -- Notes
  DELETE FROM member_note WHERE target_member_id IN (
    SELECT m.id FROM member m 
    JOIN organization o ON m.organization_id = o.id 
    WHERE o.tenant_id = p_tenant_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('member_note', v_count);

  DELETE FROM organization_note WHERE organization_id IN (
    SELECT id FROM organization WHERE tenant_id = p_tenant_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('organization_note', v_count);

  -- Bookings and tickets
  DELETE FROM booking WHERE event_id IN (SELECT id FROM event WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('booking', v_count);

  DELETE FROM program_ticket WHERE event_id IN (SELECT id FROM event WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('program_ticket', v_count);

  -- Forms
  DELETE FROM form_submission WHERE form_id IN (SELECT id FROM form WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('form_submission', v_count);

  -- Team members
  DELETE FROM team_member WHERE member_id IN (
    SELECT m.id FROM member m 
    JOIN organization o ON m.organization_id = o.id 
    WHERE o.tenant_id = p_tenant_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('team_member', v_count);

  -- Role permissions
  DELETE FROM role_member_field_permission WHERE role_id IN (SELECT id FROM role WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('role_member_field_permission', v_count);

  DELETE FROM role_organization_field_permission WHERE role_id IN (SELECT id FROM role WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('role_organization_field_permission', v_count);

  -- Member auth
  DELETE FROM member_credentials WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('member_credentials', v_count);

  -- Sessions are stored in 'session' table with JSONB sess column containing memberId
  -- Delete sessions where sess->memberId matches any member from this tenant
  DELETE FROM session WHERE sess->>'memberId' IN (
    SELECT m.id::text FROM member m 
    JOIN organization o ON m.organization_id = o.id 
    WHERE o.tenant_id = p_tenant_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('session', v_count);

  -- Tenant user auth
  DELETE FROM tenant_user_member_link WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_user_member_link', v_count);

  DELETE FROM tenant_user_credentials WHERE tenant_user_id IN (SELECT id FROM tenant_user WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_user_credentials', v_count);

  DELETE FROM tenant_user WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_user', v_count);

  -- Members and orgs
  DELETE FROM member WHERE organization_id IN (SELECT id FROM organization WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('member', v_count);

  DELETE FROM organization WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('organization', v_count);

  -- Navigation
  DELETE FROM portal_navigation_item WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('portal_navigation_item', v_count);

  DELETE FROM portal_menu WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('portal_menu', v_count);

  DELETE FROM navigation_item WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('navigation_item', v_count);

  -- Settings and content
  DELETE FROM system_settings WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('system_settings', v_count);

  DELETE FROM blog_post WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('blog_post', v_count);

  DELETE FROM resource WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('resource', v_count);

  DELETE FROM event WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('event', v_count);

  -- ROLES (including system roles - bypass flag is set)
  DELETE FROM role WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('role', v_count);

  -- Speakers and cards
  DELETE FROM speaker WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('speaker', v_count);

  DELETE FROM card WHERE deck_id IN (SELECT id FROM card_deck WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('card', v_count);

  DELETE FROM card_deck WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('card_deck', v_count);

  -- Pages, forms, workflows
  DELETE FROM page WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('page', v_count);

  DELETE FROM form WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('form', v_count);

  DELETE FROM workflow WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('workflow', v_count);

  DELETE FROM email_template WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('email_template', v_count);

  DELETE FROM voucher_code WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('voucher_code', v_count);

  DELETE FROM custom_field WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('custom_field', v_count);

  -- Xero tokens
  DELETE FROM xero_token WHERE app_tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('xero_token', v_count);

  -- Finally delete the tenant
  DELETE FROM tenant WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant', v_count);

  RETURN jsonb_build_object(
    'success', true,
    'tenant', jsonb_build_object('id', v_tenant_record.id, 'name', v_tenant_record.name, 'slug', v_tenant_record.slug),
    'deleted', v_result
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$$;

-- Grant execute only to service_role (used by API with service key)
REVOKE ALL ON FUNCTION platform_delete_tenant(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_delete_tenant(UUID) TO service_role;
