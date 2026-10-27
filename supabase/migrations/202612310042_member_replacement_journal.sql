-- Durable accounting steps only. This does not enable replacement execution.
BEGIN;
CREATE TABLE public.member_replacement_execution (
 id uuid PRIMARY KEY,
 authority_id uuid NOT NULL UNIQUE REFERENCES public.member_change_authority(id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 source_record_id uuid NOT NULL REFERENCES public.member_membership_history(id),
 approved_by uuid NOT NULL,
 approval_reason text NOT NULL CHECK(length(btrim(approval_reason)) BETWEEN 1 AND 2000),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.member_replacement_step (
 execution_id uuid NOT NULL REFERENCES public.member_replacement_execution(id),
 step_key text NOT NULL,
 position integer NOT NULL CHECK(position>=0),
 descriptor jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','uncertain','observed')),
 claim_token uuid,
 retry_at timestamptz,
 evidence jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(execution_id,step_key),
 UNIQUE(execution_id,position)
);
CREATE TABLE public.member_replacement_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 execution_id uuid NOT NULL REFERENCES public.member_replacement_execution(id),
 actor_id uuid NOT NULL,
 kind text NOT NULL,
 evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_replacement_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_replacement_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_replacement_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_replacement_execution,public.member_replacement_step,public.member_replacement_event
 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_replacement_execution,public.member_replacement_step,public.member_replacement_event TO service_role;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_replacement_execution
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_replacement_event
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();

CREATE FUNCTION public.begin_member_replacement(
 p_tenant_id uuid,p_member_id uuid,p_authority_id uuid,p_actor_id uuid,p_reason text,p_plan jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.member_change_authority; e public.member_replacement_execution;
 source jsonb; c jsonb; step jsonb; n integer:=0; target jsonb; policy jsonb; band jsonb;
BEGIN
 IF p_actor_id IS NULL OR length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 2000 THEN
  RAISE EXCEPTION 'Explicit financial approval required'; END IF;
 PERFORM 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=p_member_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Member not found'; END IF;
 SELECT * INTO a FROM public.member_change_authority
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND id=p_authority_id;
 IF NOT FOUND OR a.actor_kind<>'admin' THEN RAISE EXCEPTION 'Administrative authority required'; END IF;
 SELECT * INTO e FROM public.member_replacement_execution WHERE authority_id=a.id;
 IF FOUND THEN
  IF e.plan->>'choice' IS DISTINCT FROM p_plan->>'choice' THEN RAISE EXCEPTION 'Financial treatment is locked'; END IF;
  RETURN to_jsonb(e);
 END IF;
 SELECT to_jsonb(h) INTO source FROM public.member_membership_history h
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND id=a.source_record_id FOR UPDATE;
 c:=a.authority->'calculation';
 SELECT to_jsonb(t) INTO target FROM public.membership_tier_config t
  WHERE t.tenant_id=p_tenant_id AND t.id=(a.authority->'targetSnapshot'->>'id')::uuid FOR SHARE;
 SELECT to_jsonb(p) INTO policy FROM public.membership_change_policy p WHERE p.tenant_id=p_tenant_id FOR SHARE;
 IF a.authority->'targetBandSnapshot'->>'id' IS NOT NULL THEN
  SELECT to_jsonb(b) INTO band FROM public.membership_tier_band b
   WHERE b.tenant_id=p_tenant_id AND b.id=(a.authority->'targetBandSnapshot'->>'id')::uuid
    AND b.config_id=(target->>'id')::uuid FOR SHARE;
 END IF;
 IF source IS NULL OR source IS DISTINCT FROM a.authority->'sourceSnapshot'
  OR target IS NULL OR target IS DISTINCT FROM a.authority->'targetSnapshot'
  OR COALESCE(band,'null'::jsonb) IS DISTINCT FROM COALESCE(a.authority->'targetBandSnapshot','null'::jsonb)
  OR COALESCE(policy,'null'::jsonb) IS DISTINCT FROM COALESCE(a.authority->'policySnapshot','null'::jsonb)
  OR source->>'status' IS DISTINCT FROM 'active'
  OR a.authority->>'action' IS DISTINCT FROM 'change'
  OR c->>'behaviour' IS DISTINCT FROM 'new_term'
  OR c->'blockers' IS DISTINCT FROM '[]'::jsonb
  OR (c->>'effectiveDate')::date IS DISTINCT FROM CURRENT_DATE
  OR NOT public.member_amendment_operational_scope_supported(source,a.authority->'targetSnapshot')
  OR EXISTS(SELECT 1 FROM public.member_change_execution WHERE authority_id=a.id)
 THEN RAISE EXCEPTION 'Current verified upfront replacement authority required'; END IF;
 IF p_plan->>'version' IS DISTINCT FROM '1'
  OR p_plan->>'tenantId' IS DISTINCT FROM p_tenant_id::text
  OR p_plan->>'memberId' IS DISTINCT FROM p_member_id::text
  OR p_plan->>'sourceRecordId' IS DISTINCT FROM a.source_record_id::text
  OR p_plan->>'currency' IS DISTINCT FROM c->>'currency'
  OR p_plan->'newTerm' IS DISTINCT FROM c->'newTerm'
  OR p_plan->'targetFullPrice' IS DISTINCT FROM c->'newCost'
  OR p_plan->'additionalPaymentMinor' IS DISTINCT FROM c->'paymentDueMinor'
  OR p_plan->'surplus'->'grossMinor' IS DISTINCT FROM c->'surplusMinor'
  OR (p_plan->'transferred'->>'grossMinor')::bigint IS DISTINCT FROM
   LEAST((c->'unused'->>'grossMinor')::bigint,(c->'newCost'->>'grossMinor')::bigint)
  OR (p_plan->'transferred'->>'netMinor')::bigint+(p_plan->'surplus'->>'netMinor')::bigint
   IS DISTINCT FROM (c->'unused'->>'netMinor')::bigint
  OR (p_plan->'transferred'->>'vatMinor')::bigint+(p_plan->'surplus'->>'vatMinor')::bigint
   IS DISTINCT FROM (c->'unused'->>'vatMinor')::bigint
  OR (p_plan->>'choice'='credit' AND (p_plan->'liabilityBinding' IS DISTINCT FROM a.authority->'creditLiabilityBinding'
   OR p_plan->'liabilityBinding'->>'accountId' IS NULL))
  OR jsonb_typeof(p_plan->'steps') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_plan->'steps') NOT BETWEEN 1 AND 5
  OR NOT COALESCE(
   (p_plan->>'choice'='collect' AND (c->>'paymentDueMinor')::bigint>0)
   OR (p_plan->>'choice'='none' AND (c->>'paymentDueMinor')::bigint=0 AND (c->>'surplusMinor')::bigint=0)
   OR (p_plan->>'choice' IN ('refund','credit') AND (c->>'surplusMinor')::bigint>0
    AND a.authority->'settlement'->>'surplusHandling' IN (p_plan->>'choice','approval')),false)
 THEN RAISE EXCEPTION 'Replacement plan differs from confirmed financial terms'; END IF;
 IF (SELECT jsonb_agg(value->'key' ORDER BY ordinal) FROM jsonb_array_elements(p_plan->'steps')
  WITH ORDINALITY AS x(value,ordinal)) IS DISTINCT FROM
   ('["new_invoice"]'::jsonb
    || CASE WHEN (p_plan->'transferred'->>'grossMinor')::bigint>0 THEN '["transfer_note","transfer_allocation"]'::jsonb ELSE '[]'::jsonb END
    || CASE WHEN (p_plan->'surplus'->>'grossMinor')::bigint>0 THEN '["surplus_note"]'::jsonb ELSE '[]'::jsonb END
    || CASE WHEN p_plan->>'choice'='credit' THEN '["credit_backing"]'::jsonb ELSE '[]'::jsonb END)
 THEN RAISE EXCEPTION 'Financial step ordering is invalid'; END IF;
 INSERT INTO public.member_replacement_execution(id,authority_id,tenant_id,member_id,source_record_id,
  approved_by,approval_reason,plan)
 VALUES((p_plan->>'executionId')::uuid,a.id,p_tenant_id,p_member_id,a.source_record_id,p_actor_id,btrim(p_reason),p_plan)
 RETURNING * INTO e;
 FOR step IN SELECT value FROM jsonb_array_elements(p_plan->'steps') LOOP
  IF NOT COALESCE(step->>'kind' IN ('invoice','credit_note','allocation','backing_payment'),false)
   OR COALESCE(length(step->>'key'),0)=0
   OR step->>'currency' IS DISTINCT FROM c->>'currency'
   OR step->>'contactId' IS DISTINCT FROM a.authority->'fundingEvidence'->'providerEvidence'->>'contactId'
   OR step->>'providerTenantId' IS DISTINCT FROM a.authority->'fundingEvidence'->'providerEvidence'->>'providerTenantId'
   OR step->>'sourceInvoiceId' IS DISTINCT FROM a.authority->'fundingEvidence'->'providerEvidence'->>'sourceInvoiceId' THEN
   RAISE EXCEPTION 'Invalid financial step'; END IF;
  IF NOT COALESCE(CASE step->>'key'
   WHEN 'new_invoice' THEN step->>'kind'='invoice' AND step->'amount'=p_plan->'targetFullPrice'
    AND step->>'reference'='MR:'||(p_plan->>'executionId')||':new'
   WHEN 'transfer_note' THEN step->>'kind'='credit_note' AND step->'amount'=p_plan->'transferred'
    AND step->>'reference'='MR:'||(p_plan->>'executionId')||':transfer'
   WHEN 'transfer_allocation' THEN step->>'kind'='allocation'
    AND step->>'creditStep'='transfer_note' AND step->>'invoiceStep'='new_invoice'
    AND step->'amountMinor'=p_plan->'transferred'->'grossMinor'
   WHEN 'surplus_note' THEN step->>'kind'='credit_note' AND step->'amount'=p_plan->'surplus'
    AND step->>'reference'='MA:'||(p_plan->>'executionId')
   WHEN 'credit_backing' THEN step->>'kind'='backing_payment' AND step->'amount'=p_plan->'surplus'
    AND step->>'creditStep'='surplus_note' AND step->'liabilityBinding'=p_plan->'liabilityBinding'
    AND step->>'reference'='MA:'||(p_plan->>'executionId')
   ELSE false END,false) THEN RAISE EXCEPTION 'Financial step differs from approved amounts'; END IF;
  INSERT INTO public.member_replacement_step(execution_id,step_key,position,descriptor)
   VALUES(e.id,step->>'key',n,step);
  n:=n+1;
 END LOOP;
 INSERT INTO public.member_replacement_event(execution_id,actor_id,kind,evidence)
 VALUES(e.id,p_actor_id,'approved',jsonb_build_object('reason',btrim(p_reason)));
 RETURN to_jsonb(e);
END $$;

CREATE FUNCTION public.claim_member_replacement_step(
 p_tenant_id uuid,p_execution_id uuid,p_step_key text,p_actor_id uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.member_replacement_execution; s public.member_replacement_step;
BEGIN
 IF p_actor_id IS NULL OR length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 2000 THEN
  RAISE EXCEPTION 'Explicit financial approval required'; END IF;
 SELECT * INTO e FROM public.member_replacement_execution WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Execution not found'; END IF;
 PERFORM 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=e.member_id FOR UPDATE;
 SELECT * INTO s FROM public.member_replacement_step
  WHERE execution_id=e.id AND step_key=p_step_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Step not found'; END IF;
 IF EXISTS(SELECT 1 FROM public.member_replacement_step WHERE execution_id=e.id AND position<s.position AND state<>'observed')
 THEN RAISE EXCEPTION 'Earlier accounting steps require reconciliation'; END IF;
 IF s.state<>'pending' AND NOT(s.state='uncertain' AND s.retry_at IS NOT NULL AND s.retry_at<=now()) THEN
  RETURN jsonb_build_object('claimed',false,'step',to_jsonb(s));
 END IF;
 UPDATE public.member_replacement_step SET state='claimed',claim_token=gen_random_uuid(),
  retry_at=NULL,updated_at=now() WHERE execution_id=e.id AND step_key=p_step_key RETURNING * INTO s;
 INSERT INTO public.member_replacement_event(execution_id,actor_id,kind,evidence)
 VALUES(e.id,p_actor_id,'step_claimed',jsonb_build_object('step',p_step_key,'claim',s.claim_token,'reason',btrim(p_reason)));
 RETURN jsonb_build_object('claimed',true,'step',to_jsonb(s));
END $$;

CREATE FUNCTION public.observe_member_replacement_step(
 p_tenant_id uuid,p_execution_id uuid,p_step_key text,p_actor_id uuid,p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.member_replacement_execution; s public.member_replacement_step;
BEGIN
 IF p_actor_id IS NULL OR p_evidence->>'state' IS DISTINCT FROM 'observed'
  OR COALESCE(length(p_evidence->>'id'),0)=0 THEN RAISE EXCEPTION 'Verified provider observation required'; END IF;
 SELECT * INTO e FROM public.member_replacement_execution WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Execution not found'; END IF;
 PERFORM 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=e.member_id FOR UPDATE;
 SELECT * INTO s FROM public.member_replacement_step WHERE execution_id=e.id AND step_key=p_step_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Step not found'; END IF;
 IF s.state='observed' THEN
  IF s.evidence->>'id' IS DISTINCT FROM p_evidence->>'id' THEN RAISE EXCEPTION 'Provider identity changed'; END IF;
  RETURN to_jsonb(s);
 END IF;
 IF EXISTS(SELECT 1 FROM public.member_replacement_step WHERE execution_id=e.id AND position<s.position AND state<>'observed')
 THEN RAISE EXCEPTION 'Earlier accounting steps require reconciliation'; END IF;
 UPDATE public.member_replacement_step SET state='observed',evidence=p_evidence,retry_at=NULL,updated_at=now()
 WHERE execution_id=e.id AND step_key=p_step_key RETURNING * INTO s;
 INSERT INTO public.member_replacement_event(execution_id,actor_id,kind,evidence)
 VALUES(e.id,p_actor_id,'step_observed',jsonb_build_object('step',p_step_key,'providerId',p_evidence->>'id'));
 RETURN to_jsonb(s);
END $$;
CREATE FUNCTION public.fail_member_replacement_step(
 p_tenant_id uuid,p_execution_id uuid,p_step_key text,p_actor_id uuid,
 p_claim_token uuid,p_failure text,p_delay_seconds integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.member_replacement_execution; s public.member_replacement_step;
BEGIN
 IF p_actor_id IS NULL OR p_claim_token IS NULL OR NOT COALESCE(p_failure IN ('uncertain','throttled'),false)
  OR (p_failure='throttled' AND (p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 1 AND 86400))
 THEN RAISE EXCEPTION 'A bounded, classified claim outcome is required'; END IF;
 SELECT * INTO e FROM public.member_replacement_execution WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Execution not found'; END IF;
 PERFORM 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=e.member_id FOR UPDATE;
 SELECT * INTO s FROM public.member_replacement_step WHERE execution_id=e.id AND step_key=p_step_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Step not found'; END IF;
 IF s.state='observed' THEN RETURN to_jsonb(s); END IF;
 IF s.claim_token IS DISTINCT FROM p_claim_token OR s.state<>'claimed' THEN
  RAISE EXCEPTION 'Stale financial claim outcome'; END IF;
 UPDATE public.member_replacement_step SET state='uncertain',
  retry_at=CASE WHEN p_failure='throttled' THEN now()+make_interval(secs=>p_delay_seconds) ELSE NULL END,
  updated_at=now() WHERE execution_id=e.id AND step_key=p_step_key RETURNING * INTO s;
 INSERT INTO public.member_replacement_event(execution_id,actor_id,kind,evidence)
 VALUES(e.id,p_actor_id,'step_unresolved',jsonb_build_object('step',p_step_key,'claim',p_claim_token,'outcome',p_failure));
 RETURN to_jsonb(s);
END $$;
REVOKE ALL ON FUNCTION public.begin_member_replacement(uuid,uuid,uuid,uuid,text,jsonb),
 public.claim_member_replacement_step(uuid,uuid,text,uuid,text),
 public.observe_member_replacement_step(uuid,uuid,text,uuid,jsonb),
 public.fail_member_replacement_step(uuid,uuid,text,uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_member_replacement(uuid,uuid,uuid,uuid,text,jsonb),
 public.claim_member_replacement_step(uuid,uuid,text,uuid,text),
 public.observe_member_replacement_step(uuid,uuid,text,uuid,jsonb),
 public.fail_member_replacement_step(uuid,uuid,text,uuid,uuid,text,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
