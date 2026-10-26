-- Fixed monthly retained-term application. Dynamic pricing and replacement
-- terms are deliberately not admitted by this function.
BEGIN;
CREATE TABLE public.member_monthly_finalization_approval (
  operation_id uuid PRIMARY KEY REFERENCES public.member_amendment_provider_operation(id),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  actor_id uuid NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_monthly_finalization_approval ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_monthly_finalization_approval FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_monthly_finalization_approval TO service_role;
CREATE FUNCTION public.approve_member_monthly_finalization(
  p_tenant_id uuid,p_operation_id uuid,p_actor_id uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op public.member_amendment_provider_operation; saved public.member_monthly_finalization_approval;
BEGIN
  IF p_actor_id IS NULL OR length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Explicit administrative approval is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO op FROM public.member_amendment_provider_operation
    WHERE id=p_operation_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR op.state='aborted' OR op.claim_token IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.member_change_authority a
      WHERE a.id=(op.prepared->'input'->>'changeAuthorityId')::uuid
      AND a.tenant_id=p_tenant_id AND a.member_id=op.member_id
      AND a.source_record_id=op.source_record_id AND a.actor_kind='admin') THEN
    RAISE EXCEPTION 'Confirmed monthly authority required' USING ERRCODE='40001';
  END IF;
  SELECT * INTO saved FROM public.member_monthly_finalization_approval WHERE operation_id=op.id;
  IF FOUND THEN
    IF saved.actor_id<>p_actor_id OR saved.reason<>btrim(p_reason) THEN
      RAISE EXCEPTION 'Finalization approval is immutable' USING ERRCODE='40001';
    END IF;
    RETURN to_jsonb(saved);
  END IF;
  INSERT INTO public.member_monthly_finalization_approval(operation_id,tenant_id,actor_id,reason)
    VALUES(op.id,p_tenant_id,p_actor_id,btrim(p_reason)) RETURNING * INTO saved;
  RETURN to_jsonb(saved);
END $$;
CREATE FUNCTION public.finalize_member_monthly_amendment(
  p_tenant_id uuid,p_operation_id uuid,p_actor_id uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  op public.member_amendment_provider_operation;
  authority_row public.member_change_authority;
  a jsonb; input jsonb; source jsonb; target jsonb; band jsonb;
  application jsonb; total bigint;
BEGIN
  IF p_actor_id IS NULL OR length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Audited administrative approval is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO op FROM public.member_amendment_provider_operation
    WHERE id=p_operation_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operation not found' USING ERRCODE='40001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.member_monthly_finalization_approval
    WHERE operation_id=op.id AND tenant_id=p_tenant_id AND actor_id=p_actor_id AND reason=btrim(p_reason)) THEN
    RAISE EXCEPTION 'Durable finalization approval required' USING ERRCODE='40001';
  END IF;
  IF op.state='finalized' AND op.evidence->'application' IS NOT NULL THEN
    RETURN op.evidence->'application';
  END IF;
  input:=op.prepared->'input';
  SELECT * INTO authority_row FROM public.member_change_authority
    WHERE id=(input->>'changeAuthorityId')::uuid AND tenant_id=p_tenant_id
      AND member_id=op.member_id AND source_record_id=op.source_record_id;
  a:=authority_row.authority;
  IF a IS NULL OR authority_row.actor_kind<>'admin'
    OR op.state<>'provider_applied' OR op.claim_token IS NULL
    OR op.updated_at < clock_timestamp()-interval '60 seconds'
    OR op.evidence->>'status' IS DISTINCT FROM 'provider_applied'
    OR op.evidence->>'fingerprint' IS DISTINCT FROM op.fingerprint
    OR COALESCE(op.prepared->'mutation'->>'kind','') NOT IN ('stripe_schedule','gc_amount')
    OR a->>'action' IS DISTINCT FROM 'change'
    OR a->'calculation'->>'behaviour' IS DISTINCT FROM 'retain_term'
    OR a->'calculation'->>'effectiveDate' IS DISTINCT FROM input->>'effectiveDate'
    OR a->'calculation'->>'surplusMinor' IS DISTINCT FROM '0'
    -- Carrying prepaid value needs its own accounting/credit settlement.
    -- This fixed-monthly finalizer must not silently spend an invoice credit.
    OR a->'calculation'->'finance'->'available'->>'netMinor' IS DISTINCT FROM '0'
    OR a->'calculation'->'finance'->'available'->>'vatMinor' IS DISTINCT FROM '0'
    OR a->'calculation'->'finance'->'blockers' IS DISTINCT FROM '[]'::jsonb
    OR a->'calculation'->'blockers' IS DISTINCT FROM '["provider_schedule_coordination_required"]'::jsonb
    OR a->'sourceSnapshot' IS DISTINCT FROM input->'purchase'
    OR a->'sourceSnapshot'->'commitment_snapshot'->>'payment_frequency' IS DISTINCT FROM 'monthly'
    OR a->'fundingEvidence'->>'complete' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Verified monthly approval and provider settlement are required' USING ERRCODE='40001';
  END IF;
  -- Same plan lock as collection reservation and hold guards.
  PERFORM 1 FROM public.membership_payment_plans WHERE id=op.plan_id
    AND tenant_id=p_tenant_id AND member_id=op.member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Plan ownership changed' USING ERRCODE='40001'; END IF;
  SELECT to_jsonb(h) INTO source FROM public.member_membership_history h
    WHERE id=op.source_record_id AND tenant_id=p_tenant_id AND member_id=op.member_id FOR UPDATE;
  SELECT to_jsonb(c) INTO target FROM public.membership_tier_config c
    WHERE id=(a->'targetSnapshot'->>'id')::uuid AND tenant_id=p_tenant_id FOR SHARE;
  IF a->'targetBandSnapshot' IS NOT NULL AND a->'targetBandSnapshot'<>'null'::jsonb THEN
    SELECT to_jsonb(b) INTO band FROM public.membership_tier_band b
      WHERE id=(a->'targetBandSnapshot'->>'id')::uuid AND tenant_id=p_tenant_id
        AND config_id=(target->>'id')::uuid FOR SHARE;
  END IF;
  IF source IS NULL OR source IS DISTINCT FROM input->'purchase'
    OR source->>'status' IS DISTINCT FROM 'active'
    OR source->>'billing_agreement_id' IS DISTINCT FROM input->'agreement'->>'id'
    OR target IS NULL OR target IS DISTINCT FROM a->'targetSnapshot'
    OR target->>'structure_scope_type' IS DISTINCT FROM 'member'
    OR COALESCE(band,'null'::jsonb) IS DISTINCT FROM COALESCE(a->'targetBandSnapshot','null'::jsonb)
    OR (input->>'effectiveDate')::date < (source->>'term_start_date')::date
    OR (input->>'effectiveDate')::date >= (source->>'membership_renewal_date')::date
    OR (source->>'membership_renewal_date')::date <= CURRENT_DATE
    OR a->'calculation'->'newTerm'->>'startDate' IS DISTINCT FROM input->>'effectiveDate'
    OR a->'calculation'->'newTerm'->>'renewalDate' IS DISTINCT FROM source->>'membership_renewal_date'
    OR EXISTS(SELECT 1 FROM public.member_amendment_provider_operation x
      WHERE x.source_record_id=op.source_record_id AND x.id<>op.id AND x.state='finalized') THEN
    RAISE EXCEPTION 'Retained-term monthly membership authority changed' USING ERRCODE='40001';
  END IF;
  total:=(op.prepared->'quote'->>'amountMinor')::bigint
    * jsonb_array_length(op.prepared->'quote'->'collectionDates');
  IF total IS NULL OR total<=0
    OR total IS DISTINCT FROM (a->'calculation'->>'futureObligationMinor')::bigint THEN
    RAISE EXCEPTION 'Approved obligation differs from provider schedule' USING ERRCODE='40001';
  END IF;
  application:=jsonb_build_object(
    'operationId',op.id,'authorityId',authority_row.id,
    'effectiveDate',input->>'effectiveDate','expiresOn',source->>'membership_renewal_date',
    'appliedAt',now(),'approvedBy',p_actor_id,'reason',btrim(p_reason),
    'targetSnapshot',jsonb_build_object('config',target,'band',band));
  -- Application and hold release share one row/transaction. No original
  -- purchase, consent, generated collection or invoice is overwritten.
  UPDATE public.member_amendment_provider_operation SET state='finalized',
    evidence=evidence||jsonb_build_object('application',application),updated_at=now()
    WHERE id=op.id;
  INSERT INTO public.member_amendment_provider_event(operation_id,actor_id,state,evidence)
    VALUES(op.id,p_actor_id,'finalized',application);
  RETURN application;
END $$;
CREATE FUNCTION public.pending_member_monthly_finalizations(p_limit integer DEFAULT 30)
RETURNS TABLE(tenant_id uuid,member_id uuid,actor_id uuid,operation_key text,reason text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT o.tenant_id,o.member_id,a.actor_id,o.operation_key,a.reason
    FROM public.member_monthly_finalization_approval a
    JOIN public.member_amendment_provider_operation o ON o.id=a.operation_id AND o.tenant_id=a.tenant_id
    WHERE o.state IN ('executing','uncertain','provider_applied') AND o.claim_token IS NOT NULL
    ORDER BY o.updated_at,o.id LIMIT greatest(1,least(COALESCE(p_limit,30),100))
$$;
REVOKE ALL ON FUNCTION public.finalize_member_monthly_amendment(uuid,uuid,uuid,text),
  public.approve_member_monthly_finalization(uuid,uuid,uuid,text),
  public.pending_member_monthly_finalizations(integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.finalize_member_monthly_amendment(uuid,uuid,uuid,text),
  public.approve_member_monthly_finalization(uuid,uuid,uuid,text),
  public.pending_member_monthly_finalizations(integer) TO service_role;
COMMIT;
