-- Recurring-payment arrears restriction roles.
-- Idempotent: safe to re-run.

ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS dd_arrears_fallback_role_id UUID;

CREATE TABLE IF NOT EXISTS membership_arrears_role_action (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES membership_payment_plans(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  config_id UUID REFERENCES membership_tier_config(id) ON DELETE SET NULL,
  previous_role_id UUID,
  assigned_role_id UUID NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at TIMESTAMPTZ,
  restoration_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE membership_arrears_role_action
  DROP CONSTRAINT IF EXISTS membership_arrears_role_action_plan_id_member_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS membership_arrears_role_action_pending_member_idx
  ON membership_arrears_role_action (plan_id, member_id)
  WHERE restored_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'membership_arrears_role_action_restoration_status_check'
  ) THEN
    ALTER TABLE membership_arrears_role_action
      ADD CONSTRAINT membership_arrears_role_action_restoration_status_check
      CHECK (
        restoration_status IS NULL
        OR restoration_status IN ('restored', 'manual_change_preserved', 'member_missing')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS membership_arrears_role_action_tenant_plan_idx
  ON membership_arrears_role_action (tenant_id, plan_id);

CREATE INDEX IF NOT EXISTS membership_arrears_role_action_pending_restore_idx
  ON membership_arrears_role_action (tenant_id, plan_id)
  WHERE restored_at IS NULL;

CREATE OR REPLACE FUNCTION apply_membership_arrears_fallback_role(
  p_tenant_id UUID,
  p_plan_id UUID,
  p_member_id UUID,
  p_config_id UUID,
  p_assigned_role_id UUID
)
RETURNS TABLE (
  result_status TEXT,
  original_role_id UUID,
  assigned_role_name TEXT,
  role_action_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member member%ROWTYPE;
  v_role role%ROWTYPE;
  v_plan membership_payment_plans%ROWTYPE;
  v_action membership_arrears_role_action%ROWTYPE;
BEGIN
  SELECT * INTO v_plan
  FROM membership_payment_plans
  WHERE id = p_plan_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'arrears payment plan does not belong to tenant';
  END IF;

  SELECT * INTO v_role
  FROM role
  WHERE id = p_assigned_role_id
    AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'arrears fallback role does not belong to tenant';
  END IF;
  IF v_role.is_tenant_admin IS TRUE THEN
    RAISE EXCEPTION 'tenant administrator role cannot be an arrears fallback role';
  END IF;

  SELECT * INTO v_member
  FROM member
  WHERE id = p_member_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'member_missing'::TEXT, NULL::UUID, v_role.name, NULL::UUID;
    RETURN;
  END IF;

  IF v_plan.member_id IS NOT NULL THEN
    IF v_member.id IS DISTINCT FROM v_plan.member_id THEN
      RAISE EXCEPTION 'member is not the arrears payment plan target';
    END IF;
  ELSIF v_plan.organization_id IS NOT NULL THEN
    IF v_member.organization_id IS DISTINCT FROM v_plan.organization_id THEN
      RAISE EXCEPTION 'member does not belong to the arrears payment plan organisation';
    END IF;
  ELSE
    RAISE EXCEPTION 'arrears payment plan has no member or organisation target';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM role
    WHERE id = v_member.role_id
      AND tenant_id = p_tenant_id
      AND is_tenant_admin IS TRUE
  ) THEN
    RETURN QUERY SELECT 'tenant_admin_protected'::TEXT, v_member.role_id, v_role.name, NULL::UUID;
    RETURN;
  END IF;

  SELECT * INTO v_action
  FROM membership_arrears_role_action
  WHERE tenant_id = p_tenant_id
    AND plan_id = p_plan_id
    AND member_id = p_member_id
    AND restored_at IS NULL
  FOR UPDATE;
  IF FOUND THEN
    RETURN QUERY SELECT 'already_applied'::TEXT, v_action.previous_role_id, v_role.name, v_action.id;
    RETURN;
  END IF;

  IF v_member.role_id IS NOT DISTINCT FROM p_assigned_role_id THEN
    RETURN QUERY SELECT 'already_has_role'::TEXT, v_member.role_id, v_role.name, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO membership_arrears_role_action (
    tenant_id,
    plan_id,
    member_id,
    config_id,
    previous_role_id,
    assigned_role_id,
    applied_at,
    updated_at
  )
  VALUES (
    p_tenant_id,
    p_plan_id,
    p_member_id,
    p_config_id,
    v_member.role_id,
    p_assigned_role_id,
    now(),
    now()
  )
  RETURNING * INTO v_action;

  UPDATE member
  SET role_id = p_assigned_role_id
  WHERE id = p_member_id
    AND tenant_id = p_tenant_id;

  RETURN QUERY SELECT 'applied'::TEXT, v_member.role_id, v_role.name, v_action.id;
END;
$$;

CREATE OR REPLACE FUNCTION restore_membership_arrears_fallback_role(
  p_tenant_id UUID,
  p_action_id UUID
)
RETURNS TABLE (result_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action membership_arrears_role_action%ROWTYPE;
  v_member member%ROWTYPE;
  v_status TEXT;
BEGIN
  SELECT * INTO v_action
  FROM membership_arrears_role_action
  WHERE id = p_action_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;
  IF NOT FOUND OR v_action.restored_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_completed'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_member
  FROM member
  WHERE id = v_action.member_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_status := 'member_missing';
  ELSIF v_member.role_id IS NOT DISTINCT FROM v_action.assigned_role_id THEN
    UPDATE member
    SET role_id = v_action.previous_role_id
    WHERE id = v_member.id
      AND tenant_id = p_tenant_id;
    v_status := 'restored';
  ELSE
    v_status := 'manual_change_preserved';
  END IF;

  UPDATE membership_arrears_role_action
  SET restored_at = now(),
      restoration_status = v_status,
      updated_at = now()
  WHERE id = v_action.id;

  RETURN QUERY SELECT v_status;
END;
$$;

REVOKE ALL ON FUNCTION apply_membership_arrears_fallback_role(UUID, UUID, UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION restore_membership_arrears_fallback_role(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_membership_arrears_fallback_role(UUID, UUID, UUID, UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION restore_membership_arrears_fallback_role(UUID, UUID)
  TO service_role;