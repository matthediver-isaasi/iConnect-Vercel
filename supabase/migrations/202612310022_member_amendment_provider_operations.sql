-- Durable monthly provider writes. This does not enable a member endpoint or
-- apply entitlement. A verified provider result keeps its hold until a separate
-- transactional entitlement finalizer is implemented.
BEGIN;
CREATE TABLE public.member_amendment_provider_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  source_record_id uuid NOT NULL REFERENCES public.member_membership_history(id),
  plan_id uuid NOT NULL REFERENCES public.membership_payment_plans(id),
  actor_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 8 AND 128),
  prepared jsonb NOT NULL CHECK (jsonb_typeof(prepared) = 'object'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','executing','uncertain','provider_applied','finalized','aborted')),
  claim_token uuid,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, operation_key)
);
CREATE UNIQUE INDEX member_amendment_provider_one_active_plan
  ON public.member_amendment_provider_operation(plan_id)
  WHERE state NOT IN ('finalized','aborted');
CREATE UNIQUE INDEX member_amendment_provider_one_active_purchase
  ON public.member_amendment_provider_operation(source_record_id)
  WHERE state NOT IN ('finalized','aborted');
CREATE TABLE public.member_amendment_provider_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES public.member_amendment_provider_operation(id),
  actor_id uuid NOT NULL,
  state text NOT NULL,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_amendment_provider_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_amendment_provider_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_amendment_provider_operation,public.member_amendment_provider_event
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_amendment_provider_operation,public.member_amendment_provider_event TO service_role;

CREATE FUNCTION public.reserve_member_amendment_provider_operation(
  p_tenant_id uuid,p_member_id uuid,p_actor_id uuid,p_key text,p_prepared jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  saved public.member_amendment_provider_operation;
  source jsonb; plan jsonb; agreement jsonb; input jsonb := p_prepared->'input';
  v_plan_id uuid := (input->'plan'->>'id')::uuid;
BEGIN
  IF p_actor_id IS NULL OR p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 128
    OR p_prepared->>'version' IS DISTINCT FROM '1'
    OR COALESCE(p_prepared->>'fingerprint','') !~ '^[a-f0-9]{64}$'
    OR input->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR input->>'memberId' IS DISTINCT FROM p_member_id::text
    OR input->>'amendmentId' IS DISTINCT FROM p_key
    OR (p_prepared->'mutation'->>'kind') NOT IN ('stripe_schedule','gc_amount')
    OR p_prepared->'mutation'->>'kind' IS NULL THEN
    RAISE EXCEPTION 'Invalid monthly provider operation' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=p_member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='40001'; END IF;
  SELECT * INTO saved FROM public.member_amendment_provider_operation
    WHERE tenant_id=p_tenant_id AND operation_key=p_key;
  IF FOUND THEN
    IF saved.member_id<>p_member_id OR saved.prepared IS DISTINCT FROM p_prepared THEN
      RAISE EXCEPTION 'Operation key already belongs to different evidence' USING ERRCODE='40001';
    END IF;
    RETURN jsonb_build_object('operation',to_jsonb(saved),'replayed',true);
  END IF;
  SELECT to_jsonb(p) INTO plan FROM public.membership_payment_plans p
    WHERE p.id=v_plan_id AND p.tenant_id=p_tenant_id AND p.member_id=p_member_id FOR UPDATE;
  IF NOT FOUND OR plan IS DISTINCT FROM input->'plan'
    OR plan->>'organization_id' IS NOT NULL OR plan->>'auto_retry_claim_token' IS NOT NULL
    OR plan->>'collection_stopped_at' IS NOT NULL THEN
    RAISE EXCEPTION 'Plan changed or collection/cancellation is in progress' USING ERRCODE='40001';
  END IF;
  SELECT to_jsonb(s) INTO source FROM public.member_membership_history s
    WHERE s.id=(input->'purchase'->>'id')::uuid AND s.tenant_id=p_tenant_id AND s.member_id=p_member_id FOR UPDATE;
  SELECT to_jsonb(a) INTO agreement FROM public.membership_billing_agreements a
    WHERE a.id=(plan->>'billing_agreement_id')::uuid AND a.tenant_id=p_tenant_id AND a.member_id=p_member_id FOR SHARE;
  IF source IS DISTINCT FROM input->'purchase' OR source IS NULL
    OR source->>'status' IS DISTINCT FROM 'active'
    OR source->>'billing_agreement_id' IS DISTINCT FROM plan->>'billing_agreement_id'
    OR agreement IS NULL OR agreement IS DISTINCT FROM input->'agreement'
    OR agreement->>'organization_id' IS NOT NULL THEN
    RAISE EXCEPTION 'Purchased monthly authority changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.gocardless_collection_reservations r
      WHERE r.plan_id=v_plan_id AND r.status='reserved')
    OR EXISTS (SELECT 1 FROM public.gocardless_payments p
      WHERE p.plan_id=v_plan_id AND p.status NOT IN ('confirmed','paid_out','cancelled')) THEN
    RAISE EXCEPTION 'Collections require reconciliation before amendment' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.member_amendment_provider_operation
    (tenant_id,member_id,source_record_id,plan_id,actor_id,operation_key,prepared,fingerprint)
    VALUES(p_tenant_id,p_member_id,(source->>'id')::uuid,v_plan_id,p_actor_id,p_key,
      p_prepared,p_prepared->>'fingerprint') RETURNING * INTO saved;
  INSERT INTO public.member_amendment_provider_event(operation_id,actor_id,state)
    VALUES(saved.id,p_actor_id,'reserved');
  RETURN jsonb_build_object('operation',to_jsonb(saved),'replayed',false);
END $$;

CREATE FUNCTION public.claim_member_amendment_provider_operation(p_tenant_id uuid,p_id uuid,p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved public.member_amendment_provider_operation; current_plan jsonb; current_source jsonb; current_agreement jsonb;
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'Actor required'; END IF;
  SELECT * INTO saved FROM public.member_amendment_provider_operation
    WHERE tenant_id=p_tenant_id AND id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operation not found' USING ERRCODE='40001'; END IF;
  IF saved.state<>'reserved' THEN
    RETURN jsonb_build_object('claimed',false,'operation',to_jsonb(saved));
  END IF;
  SELECT to_jsonb(p) INTO current_plan FROM public.membership_payment_plans p
    WHERE p.id=saved.plan_id AND p.tenant_id=p_tenant_id FOR UPDATE;
  SELECT to_jsonb(s) INTO current_source FROM public.member_membership_history s
    WHERE s.id=saved.source_record_id AND s.tenant_id=p_tenant_id FOR UPDATE;
  SELECT to_jsonb(a) INTO current_agreement FROM public.membership_billing_agreements a
    WHERE a.id=(current_plan->>'billing_agreement_id')::uuid AND a.tenant_id=p_tenant_id FOR SHARE;
  IF current_plan IS DISTINCT FROM saved.prepared->'input'->'plan'
    OR current_source IS DISTINCT FROM saved.prepared->'input'->'purchase'
    OR current_agreement IS DISTINCT FROM saved.prepared->'input'->'agreement' THEN
    RAISE EXCEPTION 'Monthly authority changed before provider claim' USING ERRCODE='40001';
  END IF;
  UPDATE public.member_amendment_provider_operation SET
    state='executing',claim_token=gen_random_uuid(),updated_at=now()
    WHERE id=saved.id RETURNING * INTO saved;
  INSERT INTO public.member_amendment_provider_event(operation_id,actor_id,state)
    VALUES(saved.id,p_actor_id,'executing');
  RETURN jsonb_build_object('claimed',true,'operation',to_jsonb(saved));
END $$;

-- Only an operation that never acquired a provider-write claim can be
-- abandoned. Uncertain/provider-applied work must retain its hold.
CREATE FUNCTION public.abandon_member_amendment_provider_operation(
  p_tenant_id uuid,p_id uuid,p_actor_id uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved public.member_amendment_provider_operation;
BEGIN
  SELECT * INTO saved FROM public.member_amendment_provider_operation
    WHERE tenant_id=p_tenant_id AND id=p_id FOR UPDATE;
  IF NOT FOUND OR p_actor_id IS NULL OR saved.state<>'reserved' OR saved.claim_token IS NOT NULL
    OR length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Only unclaimed operations can be abandoned with an audited reason' USING ERRCODE='40001';
  END IF;
  UPDATE public.member_amendment_provider_operation SET state='aborted',updated_at=now()
    WHERE id=saved.id RETURNING * INTO saved;
  INSERT INTO public.member_amendment_provider_event(operation_id,actor_id,state,evidence)
    VALUES(saved.id,p_actor_id,'aborted',jsonb_build_object('reason',p_reason));
  RETURN to_jsonb(saved);
END $$;

CREATE FUNCTION public.record_member_amendment_provider_result(
  p_tenant_id uuid,p_id uuid,p_actor_id uuid,p_claim_token uuid,p_result jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved public.member_amendment_provider_operation; next_state text;
BEGIN
  SELECT * INTO saved FROM public.member_amendment_provider_operation
    WHERE tenant_id=p_tenant_id AND id=p_id FOR UPDATE;
  IF NOT FOUND OR p_actor_id IS NULL OR p_claim_token IS NULL
    OR saved.claim_token IS DISTINCT FROM p_claim_token
    OR saved.state NOT IN ('executing','uncertain','provider_applied') THEN
    RAISE EXCEPTION 'Operation claim is not valid' USING ERRCODE='40001';
  END IF;
  IF p_result->>'status' NOT IN ('provider_applied','not_applied','uncertain')
    OR p_result->>'status' IS NULL THEN RAISE EXCEPTION 'Invalid provider outcome'; END IF;
  -- A read saying not_applied never authorizes resubmission after a lost reply.
  next_state := CASE WHEN p_result->>'status'='provider_applied'
    THEN 'provider_applied' ELSE 'uncertain' END;
  UPDATE public.member_amendment_provider_operation SET
    state=next_state,evidence=p_result,updated_at=now() WHERE id=saved.id RETURNING * INTO saved;
  INSERT INTO public.member_amendment_provider_event(operation_id,actor_id,state,evidence)
    VALUES(saved.id,p_actor_id,next_state,p_result);
  RETURN to_jsonb(saved);
END $$;

-- All local collection/retry/cancellation claim paths use these plan/payment
-- tables. Reserve and collection guards lock the same plan to close the
-- check-then-write race. Provider webhook updates may retry while a hold exists.
CREATE FUNCTION public.guard_member_amendment_provider_hold()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE affected_plan uuid;
BEGIN
  IF TG_TABLE_NAME='membership_payment_plans' THEN
    affected_plan := OLD.id;
  ELSE
    affected_plan := NEW.plan_id;
    PERFORM 1 FROM public.membership_payment_plans WHERE id=affected_plan FOR UPDATE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.member_amendment_provider_operation o
      WHERE o.plan_id=affected_plan AND o.state NOT IN ('finalized','aborted')) THEN
    RAISE EXCEPTION 'Membership amendment collection hold requires reconciliation' USING ERRCODE='40001';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER member_amendment_provider_hold BEFORE UPDATE OR DELETE ON public.membership_payment_plans
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_amendment_provider_hold();
CREATE TRIGGER member_amendment_provider_hold BEFORE INSERT ON public.gocardless_collection_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_amendment_provider_hold();
CREATE TRIGGER member_amendment_provider_hold BEFORE INSERT ON public.gocardless_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_amendment_provider_hold();
CREATE TRIGGER member_amendment_provider_hold BEFORE INSERT ON public.gocardless_payment_retry_attempts
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_amendment_provider_hold();

REVOKE ALL ON FUNCTION public.reserve_member_amendment_provider_operation(uuid,uuid,uuid,text,jsonb),
 public.claim_member_amendment_provider_operation(uuid,uuid,uuid),
 public.record_member_amendment_provider_result(uuid,uuid,uuid,uuid,jsonb),
 public.abandon_member_amendment_provider_operation(uuid,uuid,uuid,text),
 public.guard_member_amendment_provider_hold() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.reserve_member_amendment_provider_operation(uuid,uuid,uuid,text,jsonb),
 public.claim_member_amendment_provider_operation(uuid,uuid,uuid),
 public.record_member_amendment_provider_result(uuid,uuid,uuid,uuid,jsonb),
 public.abandon_member_amendment_provider_operation(uuid,uuid,uuid,text) TO service_role;
COMMIT;
