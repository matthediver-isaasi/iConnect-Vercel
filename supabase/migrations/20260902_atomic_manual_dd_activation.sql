-- Atomically approve a manually-gated Direct Debit membership.
-- The plan, agreement, history update, and audit insert share one transaction.

CREATE OR REPLACE FUNCTION public.approve_manual_dd_membership_activation(
  p_tenant_id UUID,
  p_plan_id UUID,
  p_actor_email TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan membership_payment_plans%ROWTYPE;
  v_agreement membership_billing_agreements%ROWTYPE;
  v_history_id UUID;
  v_history_status TEXT;
  v_history_kind TEXT;
BEGIN
  SELECT *
    INTO v_plan
    FROM membership_payment_plans
   WHERE id = p_plan_id
     AND tenant_id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'detail', 'Plan not found');
  END IF;

  SELECT *
    INTO v_agreement
    FROM membership_billing_agreements
   WHERE id = v_plan.billing_agreement_id
     AND tenant_id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'detail', 'Billing agreement not found');
  END IF;

  IF v_plan.status IN ('payment_plan_cancelled', 'expired', 'cancelled', 'completed')
     OR v_agreement.status IN ('payment_plan_cancelled', 'expired', 'cancelled', 'completed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'terminal', 'detail', 'A cancelled or expired membership cannot be activated');
  END IF;

  IF v_agreement.metadata #>> '{dd,kind}' IS DISTINCT FROM 'monthly_direct_debit'
     OR v_agreement.metadata #>> '{dd,activation_rule}' IS DISTINCT FROM 'manual' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_manual', 'detail', 'This agreement does not require manual activation');
  END IF;

  IF v_agreement.member_id IS NOT NULL THEN
    v_history_kind := 'member';
    SELECT id, status
      INTO v_history_id, v_history_status
      FROM member_membership_history
     WHERE billing_agreement_id = v_agreement.id
       AND tenant_id = p_tenant_id
     FOR UPDATE;
  ELSIF v_agreement.organization_id IS NOT NULL THEN
    v_history_kind := 'organisation';
    SELECT id, status
      INTO v_history_id, v_history_status
      FROM organisation_membership_history
     WHERE billing_agreement_id = v_agreement.id
       AND tenant_id = p_tenant_id
     FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'detail', 'Agreement has no linked membership owner');
  END IF;

  IF v_history_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'detail', 'No membership history row is linked to this agreement');
  END IF;

  IF v_history_status = 'active' THEN
    RETURN jsonb_build_object('ok', true, 'updated', false, 'already_active', true, 'detail', 'Membership is already active');
  END IF;

  IF v_history_status IS DISTINCT FROM 'pending_activation' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_status',
      'detail', format('Membership is %s, not pending activation', COALESCE(v_history_status, 'missing status'))
    );
  END IF;

  IF v_history_kind = 'member' THEN
    UPDATE member_membership_history
       SET status = 'active'
     WHERE id = v_history_id
       AND tenant_id = p_tenant_id
       AND status = 'pending_activation';
  ELSE
    UPDATE organisation_membership_history
       SET status = 'active'
     WHERE id = v_history_id
       AND tenant_id = p_tenant_id
       AND status = 'pending_activation';
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'concurrent_update', 'detail', 'Membership changed before approval could be applied');
  END IF;

  INSERT INTO membership_dd_admin_actions (
    tenant_id,
    plan_id,
    billing_agreement_id,
    action,
    actor_email,
    details
  ) VALUES (
    p_tenant_id,
    v_plan.id,
    v_agreement.id,
    'manual_activate',
    p_actor_email,
    jsonb_build_object('history_id', v_history_id, 'history_kind', v_history_kind, 'from_status', v_history_status, 'to_status', 'active')
  );

  RETURN jsonb_build_object('ok', true, 'updated', true, 'activated', true, 'detail', 'Membership activated');
END;
$$;

REVOKE ALL ON FUNCTION public.approve_manual_dd_membership_activation(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_manual_dd_membership_activation(UUID, UUID, TEXT) TO service_role;