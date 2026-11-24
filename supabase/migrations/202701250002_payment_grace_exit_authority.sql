-- No rollout or approvals are inserted here. Execution remains disabled until
-- the complete renewal checkout has been verified and explicitly released.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE public.membership_payment_grace_exit_approval (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  plan_id uuid NOT NULL REFERENCES public.membership_payment_plans(id),
  history_id uuid NOT NULL REFERENCES public.member_membership_history(id),
  expected_role_id uuid NOT NULL REFERENCES public.role(id),
  approval_reference text NOT NULL CHECK(length(trim(approval_reference))>0),
  PRIMARY KEY(tenant_id,plan_id)
);
ALTER TABLE public.membership_payment_grace_exit_approval ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_payment_grace_exit_approval FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_payment_grace_exit_approval TO service_role;

ALTER TABLE public.member_membership_history ADD COLUMN payment_grace_exit_id uuid
  REFERENCES public.membership_payment_grace_exit(id);

CREATE FUNCTION public.guard_membership_payment_grace_exit_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.payment_grace_exit_id IS NOT NULL
    AND (NEW.payment_grace_exit_id IS DISTINCT FROM OLD.payment_grace_exit_id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.member_id IS DISTINCT FROM OLD.member_id
      OR NEW.id IS DISTINCT FROM OLD.id OR NEW.billing_agreement_id IS DISTINCT FROM OLD.billing_agreement_id
      OR NEW.term_start_date IS DISTINCT FROM OLD.term_start_date OR NEW.term_end_date IS DISTINCT FROM OLD.term_end_date
      OR NEW.status IS DISTINCT FROM 'expired') THEN
    RAISE EXCEPTION 'Audited payment grace expiry cannot be removed or re-parented';
  END IF;
  IF NEW.payment_grace_exit_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.membership_payment_grace_exit e WHERE e.id=NEW.payment_grace_exit_id
      AND e.tenant_id=NEW.tenant_id AND e.member_id=NEW.member_id AND e.history_id=NEW.id
      AND e.agreement_id=NEW.billing_agreement_id AND e.config_id=NEW.config_id
      AND e.original_term_start_date=NEW.term_start_date AND e.original_term_end_date=NEW.term_end_date
      AND NEW.status='expired') THEN
    RAISE EXCEPTION 'Membership payment grace expiry requires bound audit evidence';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_membership_payment_grace_exit_link() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_membership_payment_grace_exit_link
  BEFORE INSERT OR UPDATE ON public.member_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_payment_grace_exit_link();

-- Retain the original purchased dates. Only an audited expired entitlement
-- can leave the active-period exclusion constraint.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='public.member_membership_history'::regclass
      AND conname='member_membership_history_rolling_no_overlap';
  IF definition IS NULL OR position('term_key IS NOT NULL' IN definition)=0
    OR (position('cancelled_for_switch_at IS NULL' IN definition)=0
      AND NOT (position('status IS DISTINCT FROM ''replaced''::text' IN definition)>0
        AND position('status IS DISTINCT FROM ''cancelled_by_request''::text' IN definition)>0))
    OR position('payment_grace_exit_id' IN definition)>0 THEN
    RAISE EXCEPTION 'Review the existing membership overlap contract before installing payment grace expiry';
  END IF;
  ALTER TABLE public.member_membership_history DROP CONSTRAINT member_membership_history_rolling_no_overlap;
  EXECUTE 'ALTER TABLE public.member_membership_history ADD CONSTRAINT member_membership_history_rolling_no_overlap '
    || replace(definition,'term_key IS NOT NULL','term_key IS NOT NULL AND payment_grace_exit_id IS NULL');
END $$;

CREATE FUNCTION public.membership_payment_grace_exit_evidence(
  p_tenant_id uuid,p_member_id uuid,p_history_id uuid
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT to_jsonb(e) FROM public.membership_payment_grace_exit e
    JOIN public.member_membership_history h ON h.payment_grace_exit_id=e.id
      AND h.id=e.history_id AND h.tenant_id=e.tenant_id AND h.member_id=e.member_id
      AND h.billing_agreement_id=e.agreement_id AND h.config_id=e.config_id
      AND h.term_start_date=e.original_term_start_date AND h.term_end_date=e.original_term_end_date
      AND h.status='expired'
    WHERE e.tenant_id=p_tenant_id AND e.member_id=p_member_id AND e.history_id=p_history_id
      AND e.effective_at<=now();
$$;
REVOKE ALL ON FUNCTION public.membership_payment_grace_exit_evidence(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.membership_payment_grace_exit_evidence(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.apply_membership_payment_grace_exit(p_tenant_id uuid,p_plan_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  approval public.membership_payment_grace_exit_approval%ROWTYPE;
  p public.membership_payment_plans%ROWTYPE;
  h public.member_membership_history%ROWTYPE;
  c public.membership_tier_config%ROWTYPE;
  existing_id uuid; v_current_role uuid; result record; exit_id uuid;
BEGIN
  IF NOT EXISTS(SELECT FROM public.membership_payment_grace_exit_release
    WHERE tenant_id=p_tenant_id AND enabled) THEN
    RAISE EXCEPTION 'Payment grace expiry rollout is disabled';
  END IF;
  SELECT * INTO approval FROM public.membership_payment_grace_exit_approval
    WHERE tenant_id=p_tenant_id AND plan_id=p_plan_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment grace expiry has not been approved for this plan'; END IF;
  SELECT * INTO p FROM public.membership_payment_plans
    WHERE id=p_plan_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF p.member_id IS NULL OR p.organization_id IS NOT NULL THEN
    RAISE EXCEPTION 'Payment grace expiry requires an individual member';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'rolling:'||p_tenant_id::text||':member_id:'||p.member_id::text,0));
  SELECT * INTO h FROM public.member_membership_history
    WHERE id=approval.history_id AND member_id=p.member_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Approved membership was not found'; END IF;
  SELECT id INTO existing_id FROM public.membership_payment_grace_exit
    WHERE tenant_id=p_tenant_id AND plan_id=p_plan_id;
  IF existing_id IS NOT NULL THEN
    IF h.payment_grace_exit_id IS DISTINCT FROM existing_id THEN
      RAISE EXCEPTION 'Payment grace expiry audit link is inconsistent';
    END IF;
    RETURN existing_id;
  END IF;
  SELECT role_id INTO v_current_role FROM public.member
    WHERE id=p.member_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF v_current_role IS DISTINCT FROM approval.expected_role_id THEN
    RAISE EXCEPTION 'Member role changed since payment grace expiry was approved';
  END IF;
  SELECT * INTO c FROM public.membership_tier_config
    WHERE id=h.config_id AND tenant_id=p_tenant_id FOR SHARE;
  IF c.renewal_fallback_role_id IS NULL THEN RAISE EXCEPTION 'Schedule fallback role is missing'; END IF;
  -- The existing role mechanism and audit are reused, in this transaction.
  SELECT * INTO result FROM public.apply_membership_arrears_fallback_role(
    p_tenant_id,p.id,p.member_id,c.id,c.renewal_fallback_role_id);
  IF result.result_status NOT IN ('applied','already_applied') OR result.role_action_id IS NULL THEN
    RAISE EXCEPTION 'Fallback role could not be applied with an audit record';
  END IF;
  INSERT INTO public.membership_payment_grace_exit(
    tenant_id,member_id,history_id,agreement_id,plan_id,config_id,role_action_id,fallback_role_id,
    failed_payment_id,grace_expires_at,original_term_start_date,original_term_end_date,
    original_payment_status,approval_reference)
  VALUES(p_tenant_id,p.member_id,h.id,p.billing_agreement_id,p.id,c.id,result.role_action_id,
    c.renewal_fallback_role_id,p.last_payment_id,p.grace_expires_at,h.term_start_date,h.term_end_date,
    h.payment_status,approval.approval_reference) RETURNING id INTO exit_id;
  -- All validation occurs in the receipt trigger; failure rolls back the role.
  UPDATE public.member_membership_history SET status='expired',payment_grace_exit_id=exit_id
    WHERE id=h.id AND tenant_id=p_tenant_id;
  RETURN exit_id;
END $$;
REVOKE ALL ON FUNCTION public.apply_membership_payment_grace_exit(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
-- Grant execution only with the verified full checkout integration, not here.

DO $patch$
DECLARE definition text; needle text := 'IF NOT FOUND OR v_action.restored_at IS NOT NULL THEN';
BEGIN
  definition:=pg_get_functiondef('public.restore_membership_arrears_fallback_role(uuid,uuid)'::regprocedure);
  IF position(needle IN definition)=0
    AND position('IF NOT FOUND OR a.restored_at IS NOT NULL THEN' IN definition)>0
    AND position('retired_purchase_preserved' IN definition)>0 THEN
    needle:='IF NOT FOUND OR a.restored_at IS NOT NULL THEN';
  END IF;
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
    RAISE EXCEPTION 'Review arrears role restoration before installing payment grace expiry';
  END IF;
  EXECUTE replace(definition,needle,
    'IF EXISTS (SELECT FROM public.membership_payment_grace_exit
      WHERE tenant_id=p_tenant_id AND role_action_id=p_action_id) THEN
      RETURN QUERY SELECT ''payment_grace_expired''::text;
      RETURN;
    END IF;
    '||needle);
END $patch$;
COMMIT;
