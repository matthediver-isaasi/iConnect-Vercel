BEGIN;
CREATE TABLE public.member_cancellation_finance(
 request_id uuid PRIMARY KEY REFERENCES public.member_cancellation_request(id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 actor_id uuid NOT NULL,plan jsonb NOT NULL,calculation jsonb NOT NULL,source_evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.member_cancellation_finance_step(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL REFERENCES public.member_cancellation_finance(request_id),
 step_key text NOT NULL,descriptor jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','uncertain','observed')),
 claim_token uuid,evidence jsonb,updated_at timestamptz NOT NULL DEFAULT now(),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,step_key)
);
CREATE TABLE public.member_cancellation_finance_application(
 request_id uuid PRIMARY KEY REFERENCES public.member_cancellation_finance(request_id),
 actor_id uuid NOT NULL,evidence jsonb NOT NULL,applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_cancellation_finance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_cancellation_finance_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_cancellation_finance_application ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_cancellation_finance,public.member_cancellation_finance_step,
 public.member_cancellation_finance_application FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_cancellation_finance,public.member_cancellation_finance_step,
 public.member_cancellation_finance_application TO service_role;
CREATE TRIGGER member_cancellation_finance_immutable BEFORE UPDATE OR DELETE ON public.member_cancellation_finance
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();
CREATE TRIGGER member_cancellation_finance_application_immutable BEFORE UPDATE OR DELETE ON public.member_cancellation_finance_application
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();

CREATE FUNCTION public.prepare_member_cancellation_finance(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid,p_plan jsonb,p_calculation jsonb,p_source_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; f public.member_cancellation_finance; step jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR r.access_ended_at IS NULL OR p_actor_id IS NULL THEN RAISE EXCEPTION 'Applied owned cancellation required'; END IF;
 SELECT * INTO f FROM public.member_cancellation_finance WHERE request_id=p_id;
 IF FOUND THEN
  IF f.plan IS DISTINCT FROM p_plan OR f.calculation IS DISTINCT FROM p_calculation
   OR f.source_evidence IS DISTINCT FROM p_source_evidence THEN RAISE EXCEPTION 'Cancellation financial approval already exists; reconcile it'; END IF;
  RETURN to_jsonb(f);
 END IF;
 IF p_plan->>'requestId' IS DISTINCT FROM p_id::text OR p_plan->>'memberId' IS DISTINCT FROM p_member_id::text
  OR p_plan->>'sourceRecordId' IS DISTINCT FROM r.source_record_id::text
  OR p_plan->>'currency' IS DISTINCT FROM r.source_snapshot->>'currency'
  OR p_calculation->>'sourceRecordId' IS DISTINCT FROM r.source_record_id::text
  OR p_calculation->>'action' IS DISTINCT FROM 'cancel'
  OR p_calculation->>'membershipEndExclusiveDate' IS DISTINCT FROM r.effective_date::text
  OR p_calculation->>'effectiveDate' IS DISTINCT FROM r.effective_date::text
  OR p_calculation->>'accessWaitsForSettlement' IS DISTINCT FROM 'false'
  OR p_calculation->>'paymentReactivatesMembership' IS DISTINCT FROM 'false'
  OR p_source_evidence->>'complete' IS DISTINCT FROM 'true'
  OR p_source_evidence->>'sourceRecordId' IS DISTINCT FROM r.source_record_id::text
  OR p_source_evidence->>'currency' IS DISTINCT FROM p_plan->>'currency'
  OR length(COALESCE(p_source_evidence->>'providerTenantId',''))=0
  OR length(COALESCE(p_source_evidence->>'contactId',''))=0
  OR NOT COALESCE(p_plan->>'choice' IN ('collect','credit','refund','none'),false)
  OR jsonb_typeof(p_plan->'steps') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'Owned, verified cancellation finance is required'; END IF;
 IF (p_plan->>'debtMinor')::bigint IS NULL OR (p_plan->>'surplusMinor')::bigint IS NULL
  OR (p_plan->>'debtMinor')::bigint<0 OR (p_plan->>'surplusMinor')::bigint<0
  OR (p_plan->>'debtMinor')::bigint IS DISTINCT FROM (p_calculation->>'paymentDueMinor')::bigint
  OR (p_plan->>'surplusMinor')::bigint>COALESCE((p_calculation->>'surplusMinor')::bigint,-1)
  OR (p_plan->>'choice'='collect' AND ((p_plan->>'debtMinor')::bigint=0 OR (p_plan->>'surplusMinor')::bigint<>0))
  OR (p_plan->>'choice' IN ('credit','refund') AND ((p_plan->>'surplusMinor')::bigint=0 OR (p_plan->>'debtMinor')::bigint<>0))
  OR (p_plan->>'choice'='none' AND ((p_plan->>'debtMinor')::bigint<>0 OR (p_plan->>'surplusMinor')::bigint<>0))
 THEN RAISE EXCEPTION 'Financial amounts do not match the verified cancellation calculation'; END IF;
 IF p_plan->>'choice' IN ('credit','refund') AND (
  r.authority->'policySnapshot'->'policy'->>'cancellationUnusedValue' IS DISTINCT FROM 'tenant_surplus_policy'
  OR NOT COALESCE(r.authority->'policySnapshot'->'policy'->>'surplusHandling' IN (p_plan->>'choice','approval'),false)
 ) THEN RAISE EXCEPTION 'Surplus treatment differs from the approved cancellation policy'; END IF;
 IF NULLIF(r.authority->'providerPrepared','null'::jsonb) IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.member_cancellation_provider_stop WHERE id=p_id AND state='stopped'
 ) THEN RAISE EXCEPTION 'Provider collections must be stopped before financial writes'; END IF;
 IF jsonb_array_length(p_plan->'steps')>2100 THEN RAISE EXCEPTION 'Financial plan exceeds bounded scope'; END IF;
 INSERT INTO public.member_cancellation_finance(request_id,tenant_id,member_id,actor_id,plan,calculation,source_evidence)
 VALUES(p_id,p_tenant_id,p_member_id,p_actor_id,p_plan,p_calculation,p_source_evidence) RETURNING * INTO f;
 FOR step IN SELECT value FROM jsonb_array_elements(p_plan->'steps') LOOP
  IF length(COALESCE(step->>'key','')) NOT BETWEEN 1 AND 100
   OR NOT COALESCE(step->>'kind' IN ('original_invoice','invoice','credit_note','allocation','backing_payment'),false)
   OR step->>'providerTenantId' IS DISTINCT FROM p_source_evidence->>'providerTenantId'
   OR step->>'contactId' IS DISTINCT FROM p_source_evidence->>'contactId'
   OR step->>'currency' IS DISTINCT FROM p_plan->>'currency'
  THEN RAISE EXCEPTION 'Foreign or unsupported cancellation financial step'; END IF;
  INSERT INTO public.member_cancellation_finance_step(request_id,step_key,descriptor)
  VALUES(p_id,step->>'key',step);
 END LOOP;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(p_id,p_actor_id,'finance_prepared',jsonb_build_object('choice',p_plan->>'choice',
  'debtMinor',p_plan->'debtMinor','surplusMinor',p_plan->'surplusMinor'));
 RETURN to_jsonb(f);
END $$;

CREATE FUNCTION public.claim_member_cancellation_finance_step(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid,p_step_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE f public.member_cancellation_finance; s public.member_cancellation_finance_step; dependency text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 PERFORM 1 FROM public.member_cancellation_request WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 SELECT * INTO f FROM public.member_cancellation_finance
  WHERE request_id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR p_actor_id IS NULL THEN RAISE EXCEPTION 'Owned financial approval required'; END IF;
 SELECT * INTO s FROM public.member_cancellation_finance_step WHERE request_id=p_id AND step_key=p_step_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Financial step not found'; END IF;
 IF s.state<>'pending' OR s.next_attempt_at>now() THEN RETURN jsonb_build_object('claimed',false,'operation',to_jsonb(s)); END IF;
 FOREACH dependency IN ARRAY ARRAY[s.descriptor->>'creditStep',s.descriptor->>'invoiceStep'] LOOP
  IF dependency IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.member_cancellation_finance_step
   WHERE request_id=p_id AND step_key=dependency AND state='observed')
  THEN RAISE EXCEPTION 'Financial prerequisite has not been observed'; END IF;
 END LOOP;
 -- The backing payment consumes only the unallocated surplus. Do not reserve
 -- it before original-invoice reductions have been independently observed.
 IF s.descriptor->>'kind'='backing_payment' AND EXISTS(
  SELECT 1 FROM public.member_cancellation_finance_step WHERE request_id=p_id
   AND descriptor->>'kind'='allocation' AND state<>'observed'
 ) THEN RAISE EXCEPTION 'Original debt reductions must be observed first'; END IF;
 UPDATE public.member_cancellation_finance_step SET state='claimed',claim_token=gen_random_uuid(),updated_at=now()
 WHERE id=s.id RETURNING * INTO s;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(p_id,p_actor_id,'finance_step_claimed',jsonb_build_object('stepKey',p_step_key,'claimToken',s.claim_token));
 RETURN jsonb_build_object('claimed',true,'operation',to_jsonb(s));
END $$;

CREATE FUNCTION public.observe_member_cancellation_finance_step(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid,p_step_key text,p_claim_token uuid,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE f public.member_cancellation_finance; s public.member_cancellation_finance_step;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 PERFORM 1 FROM public.member_cancellation_request WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 SELECT * INTO f FROM public.member_cancellation_finance
  WHERE request_id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR p_actor_id IS NULL THEN RAISE EXCEPTION 'Owned financial approval required'; END IF;
 SELECT * INTO s FROM public.member_cancellation_finance_step WHERE request_id=p_id AND step_key=p_step_key FOR UPDATE;
 IF NOT FOUND OR s.state='pending' OR s.claim_token IS DISTINCT FROM p_claim_token THEN
  RAISE EXCEPTION 'Current exclusive financial claim required';
 END IF;
 IF s.state='observed' THEN RETURN to_jsonb(s); END IF;
 IF p_evidence->>'state'='not_submitted' THEN
  IF s.state<>'claimed' OR p_evidence->'provenNotSubmitted' IS DISTINCT FROM 'true'::jsonb THEN
   RAISE EXCEPTION 'A transport failure is not proof of non-submission';
  END IF;
  UPDATE public.member_cancellation_finance_step SET state='pending',claim_token=NULL,evidence=p_evidence,
   next_attempt_at=now()+make_interval(secs=>greatest(5,least(COALESCE((p_evidence->>'retryAfter')::integer,60),86400))),
   updated_at=now() WHERE id=s.id RETURNING * INTO s;
  INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
  VALUES(p_id,p_actor_id,'finance_step_deferred_without_submission',jsonb_build_object('stepKey',p_step_key));
  RETURN to_jsonb(s);
 END IF;
 IF NOT COALESCE(p_evidence->>'state' IN ('observed','missing','uncertain'),false) THEN
  RAISE EXCEPTION 'A financial observation is required';
 END IF;
 IF p_evidence->>'state'='observed' AND length(COALESCE(p_evidence->>'id',''))=0 THEN
  RAISE EXCEPTION 'Observed financial identity required';
 END IF;
 UPDATE public.member_cancellation_finance_step SET
  state=CASE WHEN p_evidence->>'state'='observed' THEN 'observed' ELSE 'uncertain' END,
  evidence=p_evidence,updated_at=now() WHERE id=s.id RETURNING * INTO s;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(p_id,p_actor_id,'finance_step_observed',jsonb_build_object('stepKey',p_step_key,'state',s.state));
 RETURN to_jsonb(s);
END $$;

CREATE FUNCTION public.record_member_cancellation_balance(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid,p_state text,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; f public.member_cancellation_finance;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR p_actor_id IS NULL OR r.access_ended_at IS NULL THEN RAISE EXCEPTION 'Owned applied cancellation required'; END IF;
 IF r.financial_state='settled' THEN RETURN to_jsonb(r); END IF;
 IF NOT COALESCE(p_state IN ('approval_required','awaiting_payment','awaiting_refund','manual_review','settled'),false) THEN
  RAISE EXCEPTION 'Explicit financial reconciliation outcome required';
 END IF;
 IF p_state='settled' THEN
  SELECT * INTO f FROM public.member_cancellation_finance WHERE request_id=p_id FOR UPDATE;
  IF NOT FOUND OR p_evidence->>'verified' IS DISTINCT FROM 'true'
   OR p_evidence->>'requestId' IS DISTINCT FROM p_id::text
   OR p_evidence->>'currency' IS DISTINCT FROM f.plan->>'currency'
   OR EXISTS(SELECT 1 FROM public.member_cancellation_finance_step WHERE request_id=p_id AND state<>'observed')
  THEN RAISE EXCEPTION 'Complete verified financial settlement required'; END IF;
  IF (f.plan->>'choice'='collect' AND p_evidence->>'kind' IS DISTINCT FROM 'debt_paid')
   OR (f.plan->>'choice'='refund' AND p_evidence->>'kind' IS DISTINCT FROM 'refund_paid')
   OR (f.plan->>'choice'='credit' AND p_evidence->>'kind' IS DISTINCT FROM 'member_credit_backed')
   OR (f.plan->>'choice'='none' AND p_evidence->>'kind' IS DISTINCT FROM 'zero_balance')
  THEN RAISE EXCEPTION 'Settlement treatment differs from the approved plan'; END IF;
  INSERT INTO public.member_cancellation_finance_application(request_id,actor_id,evidence)
  VALUES(p_id,p_actor_id,p_evidence);
  IF f.plan->>'choice'='credit' THEN
   -- The companion issuance migration must exist before this path is opened.
   -- Its failure rolls back the application; there is no unbacked credit state.
   PERFORM public.issue_member_cancellation_credit(p_tenant_id,p_id,p_actor_id,p_evidence);
  END IF;
 END IF;
 UPDATE public.member_cancellation_request SET financial_state=p_state WHERE id=p_id RETURNING * INTO r;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(p_id,p_actor_id,'balance_reconciled',jsonb_build_object('state',p_state,'evidence',p_evidence));
 -- This function never modifies membership access or reactivates the source.
 RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.prepare_member_cancellation_finance(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb),
 public.claim_member_cancellation_finance_step(uuid,uuid,uuid,uuid,text),
 public.observe_member_cancellation_finance_step(uuid,uuid,uuid,uuid,text,uuid,jsonb),
 public.record_member_cancellation_balance(uuid,uuid,uuid,uuid,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.prepare_member_cancellation_finance(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb),
 public.claim_member_cancellation_finance_step(uuid,uuid,uuid,uuid,text),
 public.observe_member_cancellation_finance_step(uuid,uuid,uuid,uuid,text,uuid,jsonb),
 public.record_member_cancellation_balance(uuid,uuid,uuid,uuid,text,jsonb)
 TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
