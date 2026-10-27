BEGIN;
ALTER TABLE public.member_cancellation_request
 ADD COLUMN authority jsonb,
 ADD COLUMN fingerprint text,
 ADD COLUMN financial_state text NOT NULL DEFAULT 'awaiting_reconciliation'
  CHECK(financial_state IN ('awaiting_reconciliation','approval_required','awaiting_payment','awaiting_refund','settled','manual_review'));

CREATE FUNCTION public.begin_member_cancellation(
 p_tenant_id uuid,p_member_id uuid,p_actor_id uuid,p_key text,p_fingerprint text,p_authority jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; h public.member_membership_history;
 source jsonb; agreement jsonb; plan jsonb; prepared jsonb; provider_authority jsonb;
 saved_policy public.membership_change_policy; day date;
BEGIN
 IF p_actor_id IS NULL OR p_key IS NULL OR p_key!~'^[A-Za-z0-9_.:-]{8,128}$'
  OR p_fingerprint IS NULL OR p_fingerprint!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(p_authority) IS DISTINCT FROM 'object'
  OR p_authority->>'tenantId' IS DISTINCT FROM p_tenant_id::text
  OR p_authority->>'memberId' IS DISTINCT FROM p_member_id::text
  OR p_authority->>'actorId' IS DISTINCT FROM p_actor_id::text
  OR p_authority#>>'{calculation,action}' IS DISTINCT FROM 'cancel'
  OR NOT COALESCE(p_authority->>'timing' IN ('immediate','end_of_term'),false)
  OR length(btrim(COALESCE(p_authority->>'reason',''))) NOT BETWEEN 1 AND 2000
 THEN RAISE EXCEPTION 'An authenticated, scoped cancellation approval is required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owned member required'; END IF;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND request_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF r.actor_id IS DISTINCT FROM p_actor_id OR r.fingerprint IS DISTINCT FROM p_fingerprint
   OR r.authority IS DISTINCT FROM p_authority THEN RAISE EXCEPTION 'Cancellation key belongs to different evidence'; END IF;
  RETURN to_jsonb(r);
 END IF;
 SELECT * INTO h FROM public.member_membership_history
  WHERE id=(p_authority#>>'{sourceSnapshot,id}')::uuid
   AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 source:=to_jsonb(h);
 IF h.id IS NULL OR source IS DISTINCT FROM p_authority->'sourceSnapshot'
  OR h.status IS DISTINCT FROM 'active' OR h.term_start_date IS NULL
  OR h.term_start_date>current_date OR h.membership_renewal_date IS NULL OR h.membership_renewal_date<=current_date
  OR source->>'organization_id' IS NOT NULL OR source->>'membership_source'='organisation'
 THEN RAISE EXCEPTION 'Current personal purchase changed; refresh cancellation'; END IF;
 IF EXISTS(SELECT 1 FROM public.member_cancellation_request WHERE source_record_id=h.id) THEN
  RAISE EXCEPTION 'This purchase already has a cancellation request; recover that request';
 END IF;
 IF EXISTS(SELECT 1 FROM public.member_membership_history other
  WHERE other.tenant_id=p_tenant_id AND other.member_id=p_member_id AND other.id<>h.id
   AND other.status='active' AND other.term_start_date<=current_date AND other.membership_renewal_date>current_date)
 THEN RAISE EXCEPTION 'Multiple current purchases require reconciliation'; END IF;
 IF EXISTS(SELECT 1 FROM public.member_replacement_execution e
  WHERE e.tenant_id=p_tenant_id AND e.member_id=p_member_id
   AND NOT EXISTS(SELECT 1 FROM public.member_replacement_application a WHERE a.execution_id=e.id))
 THEN RAISE EXCEPTION 'Recover the open replacement before approving cancellation'; END IF;
 SELECT * INTO saved_policy FROM public.membership_change_policy WHERE tenant_id=p_tenant_id FOR SHARE;
 IF FOUND AND (saved_policy.policy IS DISTINCT FROM p_authority#>'{policySnapshot,policy}'
  OR saved_policy.revision IS DISTINCT FROM (p_authority#>>'{policySnapshot,revision}')::bigint)
 THEN RAISE EXCEPTION 'Cancellation policy changed'; END IF;
 IF NOT FOUND AND (p_authority#>>'{policySnapshot,revision}')::bigint IS DISTINCT FROM 0 THEN
  RAISE EXCEPTION 'Cancellation policy authority changed';
 END IF;
 IF NOT FOUND AND p_authority#>>'{policySnapshot,policy,cancellationTiming}' IS DISTINCT FROM 'end_of_term' THEN
  RAISE EXCEPTION 'Default cancellation timing changed';
 END IF;
 IF p_authority->>'timing' IS DISTINCT FROM p_authority#>>'{policySnapshot,policy,cancellationTiming}' THEN
  RAISE EXCEPTION 'Cancellation timing must follow the reviewed policy';
 END IF;
 day:=CASE WHEN p_authority->>'timing'='immediate' THEN current_date ELSE h.membership_renewal_date END;
 IF p_authority->>'effectiveDate' IS DISTINCT FROM day::text
  OR p_authority#>>'{calculation,membershipEndExclusiveDate}' IS DISTINCT FROM day::text
  OR p_authority#>>'{calculation,sourceRecordId}' IS DISTINCT FROM h.id::text
 THEN RAISE EXCEPTION 'Cancellation date or source changed'; END IF;
 prepared:=NULLIF(p_authority->'providerPrepared','null'::jsonb);
 IF h.billing_agreement_id IS NOT NULL THEN
  SELECT to_jsonb(a) INTO agreement FROM public.membership_billing_agreements a
   WHERE a.id=h.billing_agreement_id AND a.tenant_id=p_tenant_id AND a.member_id=p_member_id FOR UPDATE;
  SELECT to_jsonb(p) INTO plan FROM public.membership_payment_plans p
   WHERE p.id=(p_authority#>>'{planSnapshot,id}')::uuid AND p.billing_agreement_id=h.billing_agreement_id
    AND p.tenant_id=p_tenant_id AND p.member_id=p_member_id FOR UPDATE;
  IF agreement IS NULL OR plan IS NULL OR agreement IS DISTINCT FROM p_authority->'agreementSnapshot'
   OR plan IS DISTINCT FROM p_authority->'planSnapshot' OR agreement->>'agreement_type' IS DISTINCT FROM 'member'
   OR agreement->>'organization_id' IS NOT NULL OR plan->>'organization_id' IS NOT NULL
   OR agreement->>'provider' IS DISTINCT FROM plan->>'provider'
   OR agreement->>'environment' IS DISTINCT FROM plan->>'environment'
  THEN RAISE EXCEPTION 'Owned billing plan changed'; END IF;
  IF prepared IS NULL THEN
   IF plan->>'provider' IS DISTINCT FROM 'gocardless'
    OR plan#>>'{metadata,collection_mode}' IS DISTINCT FROM 'dynamic'
    OR plan->>'gocardless_subscription_id' IS NOT NULL
   THEN RAISE EXCEPTION 'Provider stop authority is missing'; END IF;
  ELSE
   provider_authority:=prepared->'authority';
   IF provider_authority->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR provider_authority->>'memberId' IS DISTINCT FROM p_member_id::text
    OR provider_authority->>'agreementId' IS DISTINCT FROM h.billing_agreement_id::text
    OR provider_authority->>'provider' IS DISTINCT FROM plan->>'provider'
    OR provider_authority->>'environment' IS DISTINCT FROM plan->>'environment'
    OR provider_authority->>'subscriptionId' IS DISTINCT FROM
     (CASE WHEN plan->>'provider'='stripe' THEN plan->>'stripe_subscription_id' ELSE plan->>'gocardless_subscription_id' END)
   THEN RAISE EXCEPTION 'Provider authority differs from the purchased plan'; END IF;
  END IF;
 ELSIF prepared IS NOT NULL OR source#>>'{commitment_snapshot,payment_frequency}' IS DISTINCT FROM 'upfront' THEN
  RAISE EXCEPTION 'An owned billing agreement is required for recurring cancellation';
 END IF;
 INSERT INTO public.member_cancellation_request(tenant_id,member_id,source_record_id,actor_id,
  request_key,reason,effective_date,timing,source_snapshot,calculation,authority,fingerprint)
 VALUES(p_tenant_id,p_member_id,h.id,p_actor_id,p_key,btrim(p_authority->>'reason'),day,
  p_authority->>'timing',source,p_authority->'calculation',p_authority,p_fingerprint) RETURNING * INTO r;
 IF prepared IS NOT NULL THEN
  INSERT INTO public.member_cancellation_provider_stop(id,tenant_id,member_id,prepared,fingerprint)
  VALUES(r.id,p_tenant_id,p_member_id,prepared,prepared->>'fingerprint');
 END IF;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(r.id,p_actor_id,'approved',jsonb_build_object('effectiveDate',day,'timing',r.timing,
  'financialSettlementConfirmed',false,'reason',r.reason));
 IF day<=current_date THEN
  PERFORM public.apply_member_cancellation_access(p_tenant_id,p_member_id,r.id,p_actor_id);
  SELECT * INTO r FROM public.member_cancellation_request WHERE id=r.id;
 END IF;
 RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.begin_member_cancellation(uuid,uuid,uuid,text,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_member_cancellation(uuid,uuid,uuid,text,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
