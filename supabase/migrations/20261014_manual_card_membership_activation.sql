-- Approve a paid, manually gated personal card membership without provider calls.
CREATE OR REPLACE FUNCTION public.approve_manual_card_membership_activation(
  p_tenant_id uuid, p_member_id uuid, p_history_id uuid, p_actor_email text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p membership_payment_plans%ROWTYPE;
  a membership_billing_agreements%ROWTYPE;
  h member_membership_history%ROWTYPE;
  next_status text;
BEGIN
  -- Match exactly one plan before taking the same plan -> agreement lock order
  -- used by other payment-plan administrative operations.
  IF (SELECT count(*) FROM membership_payment_plans pp
      JOIN member_membership_history hh ON hh.billing_agreement_id=pp.billing_agreement_id
      WHERE hh.id=p_history_id AND hh.member_id=p_member_id AND hh.tenant_id=p_tenant_id
        AND pp.tenant_id=p_tenant_id AND pp.member_id=p_member_id) <> 1 THEN
    RETURN jsonb_build_object('ok',false,'detail','Membership payment plan is missing or ambiguous');
  END IF;
  SELECT pp.* INTO p FROM membership_payment_plans pp
    JOIN member_membership_history hh ON hh.billing_agreement_id=pp.billing_agreement_id
    WHERE hh.id=p_history_id AND hh.member_id=p_member_id AND hh.tenant_id=p_tenant_id
      AND pp.tenant_id=p_tenant_id AND pp.member_id=p_member_id FOR UPDATE OF pp;
  SELECT * INTO a FROM membership_billing_agreements
    WHERE id=p.billing_agreement_id AND tenant_id=p_tenant_id FOR UPDATE;
  SELECT * INTO h FROM member_membership_history
    WHERE id=p_history_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  IF h.id IS NULL OR a.id IS NULL OR h.billing_agreement_id IS DISTINCT FROM a.id
    OR a.member_id IS DISTINCT FROM p_member_id OR a.organization_id IS NOT NULL
    OR p.organization_id IS NOT NULL OR a.provider IS DISTINCT FROM 'stripe'
    OR a.environment IS DISTINCT FROM 'live'
    OR a.metadata #>> '{card,kind}' IS DISTINCT FROM 'monthly_card'
    OR a.metadata #>> '{card,activation_rule}' IS DISTINCT FROM 'manual' THEN
    RETURN jsonb_build_object('ok',false,'detail','No matching live, manually approved card membership');
  END IF;
  IF p.status IS DISTINCT FROM 'active' OR a.status IS DISTINCT FROM 'active'
    OR p.instalments_paid IS NULL OR p.instalments_paid < 1
    OR p.last_payment_status IS DISTINCT FROM 'paid'
    OR h.payment_status IS NULL OR h.payment_status NOT IN ('partial','paid')
    OR h.term_start_date IS NULL OR h.term_end_date IS NULL
    OR h.term_start_date > h.term_end_date OR h.term_end_date < CURRENT_DATE THEN
    RETURN jsonb_build_object('ok',false,'detail','A current paid instalment and active billing plan are required');
  END IF;
  IF h.status IN ('active','scheduled') THEN
    RETURN jsonb_build_object('ok',true,'updated',false,'detail','Membership already approved');
  END IF;
  IF h.status IS DISTINCT FROM 'pending_activation' THEN
    RETURN jsonb_build_object('ok',false,'detail','Membership is not awaiting manual activation');
  END IF;
  next_status := CASE WHEN h.term_start_date > CURRENT_DATE THEN 'scheduled' ELSE 'active' END;
  UPDATE member_membership_history SET status=next_status,
    scheduled_activation_date=CASE WHEN next_status='scheduled' THEN h.term_start_date ELSE NULL END
    WHERE id=h.id AND tenant_id=p_tenant_id AND member_id=p_member_id AND status='pending_activation';
  IF NOT FOUND THEN RAISE EXCEPTION 'Membership changed during approval'; END IF;
  INSERT INTO membership_dd_admin_actions
    (tenant_id,plan_id,billing_agreement_id,action,actor_email,details)
    VALUES(p_tenant_id,p.id,a.id,'manual_activate',p_actor_email,
      jsonb_build_object('provider','stripe','history_id',h.id,'history_kind','member',
        'from_status',h.status,'to_status',next_status,'provider_writes',0));
  RETURN jsonb_build_object('ok',true,'updated',true,'activated',next_status='active',
    'detail',CASE WHEN next_status='active' THEN 'Membership activated' ELSE 'Membership approved for its agreed start date' END);
END; $$;
REVOKE ALL ON FUNCTION public.approve_manual_card_membership_activation(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.approve_manual_card_membership_activation(uuid,uuid,uuid,text) TO service_role;
