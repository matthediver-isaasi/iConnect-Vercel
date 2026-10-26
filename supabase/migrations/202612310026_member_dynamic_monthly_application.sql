BEGIN;
CREATE FUNCTION public.claim_approved_member_amendment_provider_operation(
  p_tenant_id uuid,p_id uuid,p_actor_id uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE claimed jsonb;
BEGIN
  claimed:=public.claim_member_amendment_provider_operation(p_tenant_id,p_id,p_actor_id);
  PERFORM public.approve_member_monthly_finalization(p_tenant_id,p_id,p_actor_id,p_reason);
  RETURN claimed;
END $$;
REVOKE ALL ON FUNCTION public.claim_approved_member_amendment_provider_operation(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_approved_member_amendment_provider_operation(uuid,uuid,uuid,text) TO service_role;

ALTER FUNCTION public.finalize_member_monthly_amendment(uuid,uuid,uuid,text)
  RENAME TO finalize_member_monthly_amendment_verified;
REVOKE ALL ON FUNCTION public.finalize_member_monthly_amendment_verified(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.finalize_member_monthly_amendment(
  p_tenant_id uuid,p_operation_id uuid,p_actor_id uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op public.member_amendment_provider_operation; authority jsonb; applied jsonb;
  prepared_cash jsonb; latest_cash jsonb;
BEGIN
  SELECT * INTO op FROM public.member_amendment_provider_operation
    WHERE id=p_operation_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Monthly operation unavailable' USING ERRCODE='40001'; END IF;
  SELECT a.authority INTO authority FROM public.member_change_authority a
    WHERE a.id=(op.prepared->'input'->>'changeAuthorityId')::uuid AND a.tenant_id=p_tenant_id
      AND a.member_id=op.member_id;
  IF op.state<>'finalized' THEN
    SELECT COALESCE(jsonb_agg(p-'status' ORDER BY p->>'id'),'[]'::jsonb) INTO prepared_cash
      FROM jsonb_array_elements(op.prepared->'funding'->'payments') p;
    SELECT COALESCE(jsonb_agg(p-'status' ORDER BY p->>'id'),'[]'::jsonb) INTO latest_cash
      FROM jsonb_array_elements(op.evidence->'evidence'->'funding'->'payments') p;
    IF authority->'monthlyExecution'->'providerFunding' IS NULL
      OR authority->'monthlyExecution'->'providerFunding' IS DISTINCT FROM op.prepared->'funding'
      OR op.evidence->'evidence'->'funding' IS NULL
      OR prepared_cash IS DISTINCT FROM latest_cash THEN
      RAISE EXCEPTION 'Confirmed monthly funding changed' USING ERRCODE='40001';
    END IF;
  END IF;
  applied:=public.finalize_member_monthly_amendment_verified(p_tenant_id,p_operation_id,p_actor_id,p_reason);
  -- This is the operational future collection amount, not the immutable signed
  -- commitment or a past payment. Retry paths retain their original payment.
  IF op.state<>'finalized' THEN
    UPDATE public.membership_payment_plans SET amount_minor=(op.prepared->'quote'->>'amountMinor')::integer
      WHERE id=op.plan_id AND tenant_id=p_tenant_id AND member_id=op.member_id;
  END IF;
  RETURN applied;
END $$;
REVOKE ALL ON FUNCTION public.finalize_member_monthly_amendment(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_member_monthly_amendment(uuid,uuid,uuid,text) TO service_role;

-- Dynamic DD has no provider subscription to rewrite. Applying a new scope is
-- local and atomic; future reservations must pin that exact scope revision.
CREATE FUNCTION public.apply_member_dynamic_monthly_change(
  p_tenant_id uuid,p_member_id uuid,p_actor_id uuid,p_key text,p_reason text,p_prepared jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  input jsonb:=p_prepared->'input'; a jsonb; source jsonb; plan jsonb; agreement jsonb;
  target jsonb; band jsonb; app jsonb; op public.member_amendment_provider_operation;
  authority_id uuid:=(input->>'changeAuthorityId')::uuid;
  effective date:=(input->>'effectiveDate')::date; op_id uuid:=gen_random_uuid();
BEGIN
  IF p_actor_id IS NULL OR length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 2000
    OR p_key IS DISTINCT FROM 'monthly-change:'||authority_id::text
    OR input->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR input->>'memberId' IS DISTINCT FROM p_member_id::text
    OR input->>'amendmentId' IS DISTINCT FROM p_key
    OR p_prepared->'mutation'->>'kind' IS DISTINCT FROM 'dynamic_revision_required'
    OR input->'authority'->>'provider' IS DISTINCT FROM 'gocardless'
    OR input->'authority'->>'pricingBasis' IS DISTINCT FROM 'monthly_price'
    OR COALESCE(p_prepared->>'fingerprint','') !~ '^[a-f0-9]{64}$'
    OR p_prepared->>'verifiedAt' IS NULL
    OR (p_prepared->>'verifiedAt')::timestamptz < clock_timestamp()-interval '60 seconds'
    OR (p_prepared->>'verifiedAt')::timestamptz > clock_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'Fresh approved dynamic membership evidence required' USING ERRCODE='40001';
  END IF;
  PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member unavailable' USING ERRCODE='40001'; END IF;
  SELECT * INTO op FROM public.member_amendment_provider_operation
    WHERE tenant_id=p_tenant_id AND operation_key=p_key;
  IF FOUND THEN
    IF op.member_id=p_member_id AND op.state='finalized'
      AND op.prepared->'input'->>'changeAuthorityId'=authority_id::text
      AND EXISTS(SELECT 1 FROM public.member_monthly_finalization_approval n
        WHERE n.operation_id=op.id AND n.actor_id=p_actor_id AND n.reason=btrim(p_reason)) THEN
      RETURN to_jsonb(op);
    END IF;
    RAISE EXCEPTION 'Dynamic membership operation already exists' USING ERRCODE='40001';
  END IF;
  SELECT authority INTO a FROM public.member_change_authority
    WHERE id=authority_id AND tenant_id=p_tenant_id AND member_id=p_member_id
      AND source_record_id=(input->'purchase'->>'id')::uuid AND actor_kind='admin' FOR SHARE;
  IF a IS NULL OR a->>'action' IS DISTINCT FROM 'change'
    OR a->'monthlyExecution'->>'version' IS DISTINCT FROM '1'
    OR a->'monthlyExecution'->'providerAuthority' IS DISTINCT FROM input->'authority'
    OR a->'monthlyExecution'->'providerTarget' IS DISTINCT FROM input->'target'
    OR a->'monthlyExecution'->'providerFunding' IS NULL
    OR a->'monthlyExecution'->'providerFunding' IS DISTINCT FROM p_prepared->'funding'
    OR a->'calculation'->>'version' IS DISTINCT FROM '3'
    OR a->'calculation'->>'behaviour' IS DISTINCT FROM 'retain_term'
    OR a->'calculation'->>'effectiveDate' IS DISTINCT FROM effective::text
    OR a->'calculation'->'finance'->'blockers' IS DISTINCT FROM '[]'::jsonb
    OR a->'calculation'->'blockers' IS DISTINCT FROM '["provider_schedule_coordination_required"]'::jsonb
    OR a->'fundingEvidence'->>'complete' IS DISTINCT FROM 'true'
    OR COALESCE((a->'calculation'->'finance'->'available'->>'netMinor')::bigint,-1)<>0
    OR COALESCE((a->'calculation'->'finance'->'available'->>'vatMinor')::bigint,-1)<>0
    OR COALESCE((a->'calculation'->>'surplusMinor')::bigint,-1)<>0
    OR a->'calculation'->'futureObligationMinor' IS DISTINCT FROM 'null'::jsonb
    OR (p_prepared->'quote'->>'amountMinor')::bigint IS DISTINCT FROM
      (a->'calculation'->>'currentMonthlyPriceMinor')::bigint
    OR COALESCE((p_prepared->'quote'->>'amountMinor')::bigint,0)<=0
    OR COALESCE(jsonb_array_length(p_prepared->'quote'->'collectionDates'),0)=0 THEN
    RAISE EXCEPTION 'Confirmed prospective monthly authority required' USING ERRCODE='40001';
  END IF;
  SELECT to_jsonb(p) INTO plan FROM public.membership_payment_plans p
    WHERE p.id=(input->'plan'->>'id')::uuid AND p.tenant_id=p_tenant_id AND p.member_id=p_member_id FOR UPDATE;
  SELECT to_jsonb(s) INTO source FROM public.member_membership_history s
    WHERE s.id=(input->'purchase'->>'id')::uuid AND s.tenant_id=p_tenant_id AND s.member_id=p_member_id FOR SHARE;
  SELECT to_jsonb(g) INTO agreement FROM public.membership_billing_agreements g
    WHERE g.id=(input->'agreement'->>'id')::uuid AND g.tenant_id=p_tenant_id AND g.member_id=p_member_id FOR SHARE;
  IF plan IS NULL OR source IS NULL OR agreement IS NULL
    OR plan IS DISTINCT FROM input->'plan' OR source IS DISTINCT FROM input->'purchase'
    OR source IS DISTINCT FROM a->'sourceSnapshot' OR agreement IS DISTINCT FROM input->'agreement'
    OR source->>'status' IS DISTINCT FROM 'active'
    OR source->'commitment_snapshot'->>'payment_frequency' IS DISTINCT FROM 'monthly'
    OR plan->>'organization_id' IS NOT NULL OR agreement->>'organization_id' IS NOT NULL
    OR plan->>'status' IS DISTINCT FROM 'active' OR plan->>'auto_retry_claim_token' IS NOT NULL
    OR plan->>'collection_stopped_at' IS NOT NULL
    OR plan->'metadata'->>'collection_mode' IS DISTINCT FROM 'dynamic'
    OR plan->>'billing_agreement_id' IS DISTINCT FROM agreement->>'id'
    OR source->>'billing_agreement_id' IS DISTINCT FROM agreement->>'id'
    OR effective<CURRENT_DATE OR effective<(source->>'term_start_date')::date
    OR effective>=(source->>'membership_renewal_date')::date
    OR a->'calculation'->'newTerm'->>'startDate' IS DISTINCT FROM effective::text
    OR a->'calculation'->'newTerm'->>'renewalDate' IS DISTINCT FROM source->>'membership_renewal_date'
    OR EXISTS(SELECT 1 FROM public.member_amendment_provider_operation x
      WHERE (x.source_record_id=(source->>'id')::uuid OR x.plan_id=(plan->>'id')::uuid) AND x.state<>'aborted')
    OR EXISTS(SELECT 1 FROM public.gocardless_collection_reservations r
      WHERE r.plan_id=(plan->>'id')::uuid AND (r.status IN ('reserved','uncertain')
        OR ((to_jsonb(r)->>'due_date')::date>=effective AND r.status<>'cancelled')))
    OR EXISTS(SELECT 1 FROM public.gocardless_payments p WHERE p.plan_id=(plan->>'id')::uuid
      AND (to_jsonb(p)->>'charge_date')::date>=effective AND p.status<>'cancelled') THEN
    RAISE EXCEPTION 'Dynamic purchase or collections changed' USING ERRCODE='40001';
  END IF;
  SELECT to_jsonb(c) INTO target FROM public.membership_tier_config c
    WHERE c.id=(a->'targetSnapshot'->>'id')::uuid AND c.tenant_id=p_tenant_id FOR SHARE;
  IF a->'targetBandSnapshot' IS NOT NULL AND a->'targetBandSnapshot'<>'null'::jsonb THEN
    SELECT to_jsonb(b) INTO band FROM public.membership_tier_band b
      WHERE b.id=(a->'targetBandSnapshot'->>'id')::uuid AND b.tenant_id=p_tenant_id
        AND b.config_id=(target->>'id')::uuid FOR SHARE;
  END IF;
  IF target IS NULL OR target IS DISTINCT FROM a->'targetSnapshot'
    OR COALESCE(band,'null'::jsonb) IS DISTINCT FROM COALESCE(a->'targetBandSnapshot','null'::jsonb)
    OR target->>'structure_scope_type' IS DISTINCT FROM 'member'
    OR target->>'dd_enabled' IS DISTINCT FROM 'true'
    OR target->>'is_active'='false'
    OR upper(target->>'currency') IS DISTINCT FROM input->'authority'->>'currency'
    OR round((COALESCE(band,target)->>'dd_monthly_amount')::numeric*100)::bigint
      IS DISTINCT FROM (p_prepared->'quote'->>'amountMinor')::bigint THEN
    RAISE EXCEPTION 'Target monthly structure changed' USING ERRCODE='40001';
  END IF;
  app:=jsonb_build_object('operationId',op_id,'authorityId',authority_id,'effectiveDate',effective,
    'expiresOn',source->>'membership_renewal_date','appliedAt',clock_timestamp(),'approvedBy',p_actor_id,
    'reason',btrim(p_reason),'targetSnapshot',jsonb_build_object('config',target,'band',band));
  INSERT INTO public.member_amendment_provider_operation
    (id,tenant_id,member_id,source_record_id,plan_id,actor_id,operation_key,prepared,fingerprint,state,claim_token,evidence)
    VALUES(op_id,p_tenant_id,p_member_id,(source->>'id')::uuid,(plan->>'id')::uuid,p_actor_id,p_key,
      p_prepared,p_prepared->>'fingerprint','finalized',gen_random_uuid(),
      jsonb_build_object('status','local_revision_applied','application',app)) RETURNING * INTO op;
  INSERT INTO public.member_monthly_finalization_approval(operation_id,tenant_id,actor_id,reason)
    VALUES(op_id,p_tenant_id,p_actor_id,btrim(p_reason));
  INSERT INTO public.member_amendment_provider_event(operation_id,actor_id,state,evidence)
    VALUES(op_id,p_actor_id,'finalized',app);
  RETURN to_jsonb(op);
END $$;
REVOKE ALL ON FUNCTION public.apply_member_dynamic_monthly_change(uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_member_dynamic_monthly_change(uuid,uuid,uuid,text,text,jsonb) TO service_role;

CREATE FUNCTION public.guard_dynamic_membership_scope_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE revision uuid; scope jsonb; config jsonb; band jsonb;
  due date:=(to_jsonb(NEW)->>'due_date')::date;
BEGIN
  IF TG_OP='UPDATE' AND NEW.price_snapshot IS NOT DISTINCT FROM OLD.price_snapshot
    AND NEW.plan_id=OLD.plan_id AND NEW.due_date=OLD.due_date
    AND NOT(NEW.status IN ('reserved','uncertain') AND OLD.status NOT IN ('reserved','uncertain')) THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.membership_payment_plans WHERE id=NEW.plan_id FOR UPDATE;
  SELECT o.id,o.evidence->'application'->'targetSnapshot' INTO revision,scope
    FROM public.member_amendment_provider_operation o
    WHERE o.plan_id=NEW.plan_id AND o.state='finalized'
      AND o.prepared->'input'->'authority'->>'pricingBasis'='monthly_price'
      AND (o.evidence->'application'->>'effectiveDate')::date<=due
      AND (o.evidence->'application'->>'expiresOn')::date>due;
  IF COALESCE(NEW.price_snapshot->>'membership_revision_id','') IS DISTINCT FROM COALESCE(revision::text,'') THEN
    RAISE EXCEPTION 'Dynamic membership scope changed; refresh collection price' USING ERRCODE='40001';
  END IF;
  IF revision IS NOT NULL THEN
    SELECT to_jsonb(c) INTO config FROM public.membership_tier_config c
      WHERE c.id=(NEW.price_snapshot->>'config_id')::uuid
        AND c.tenant_id=(scope->'config'->>'tenant_id')::uuid FOR SHARE;
    IF NEW.price_snapshot->>'band_id' IS NOT NULL THEN
      SELECT to_jsonb(b) INTO band FROM public.membership_tier_band b
        WHERE b.id=(NEW.price_snapshot->>'band_id')::uuid AND b.config_id=(config->>'id')::uuid
          AND b.tenant_id=(scope->'config'->>'tenant_id')::uuid FOR SHARE;
    END IF;
    IF config IS NULL OR config IS DISTINCT FROM NEW.price_snapshot->'config'
      OR COALESCE(band,'null'::jsonb) IS DISTINCT FROM COALESCE(NEW.price_snapshot->'band','null'::jsonb)
      OR jsonb_build_array(config->'structure_scope_type',config->'structure_field_id',
        config->'structure_match_value',config->'start_mode',config->'currency')
        IS DISTINCT FROM jsonb_build_array(scope->'config'->'structure_scope_type',scope->'config'->'structure_field_id',
        scope->'config'->'structure_match_value',scope->'config'->'start_mode',scope->'config'->'currency')
      OR (band IS NOT NULL AND jsonb_build_array(band->'min_value',band->'max_value',band->'match_value')
        IS DISTINCT FROM jsonb_build_array(scope->'band'->'min_value',scope->'band'->'max_value',scope->'band'->'match_value'))
      OR round((COALESCE(band,config)->>'dd_monthly_amount')::numeric*100)::bigint
        IS DISTINCT FROM (NEW.price_snapshot->>'monthly_amount_minor')::bigint THEN
      RAISE EXCEPTION 'Dynamic collection price does not match its membership scope' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_dynamic_membership_scope_reservation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER dynamic_membership_scope_reservation BEFORE INSERT OR UPDATE ON public.gocardless_collection_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_dynamic_membership_scope_reservation();

CREATE TABLE public.member_monthly_change_notification (
  operation_id uuid PRIMARY KEY REFERENCES public.member_amendment_provider_operation(id),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','sent','uncertain','blocked')),
  claim_token uuid, claimed_at timestamptz, evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_monthly_change_notification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_monthly_change_notification FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_monthly_change_notification TO service_role;
CREATE FUNCTION public.queue_monthly_change_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.state='finalized' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM 'finalized') THEN
    IF NEW.evidence->'application'->>'operationId' IS DISTINCT FROM NEW.id::text THEN
      RAISE EXCEPTION 'Finalized monthly application evidence required';
    END IF;
    INSERT INTO public.member_monthly_change_notification(operation_id,tenant_id)
      VALUES(NEW.id,NEW.tenant_id) ON CONFLICT(operation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER monthly_change_notification AFTER INSERT OR UPDATE OF state
  ON public.member_amendment_provider_operation FOR EACH ROW EXECUTE FUNCTION public.queue_monthly_change_notification();
CREATE FUNCTION public.claim_monthly_change_notification(p_tenant_id uuid,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n public.member_monthly_change_notification;
BEGIN
  UPDATE public.member_monthly_change_notification SET state='claimed',claim_token=gen_random_uuid(),
    claimed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE operation_id=p_operation_id AND tenant_id=p_tenant_id AND state='pending'
    RETURNING * INTO n;
  RETURN CASE WHEN FOUND THEN to_jsonb(n) ELSE NULL END;
END $$;
CREATE FUNCTION public.finish_monthly_change_notification(
  p_tenant_id uuid,p_operation_id uuid,p_claim_token uuid,p_state text,p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n public.member_monthly_change_notification;
BEGIN
  IF p_state NOT IN ('pending','sent','uncertain','blocked') OR jsonb_typeof(p_evidence)<>'object' THEN
    RAISE EXCEPTION 'Invalid monthly notification outcome';
  END IF;
  UPDATE public.member_monthly_change_notification SET state=p_state,evidence=p_evidence,
    updated_at=clock_timestamp(),claim_token=CASE WHEN p_state='pending' THEN NULL ELSE claim_token END
    WHERE operation_id=p_operation_id AND tenant_id=p_tenant_id AND claim_token=p_claim_token
      AND (state='claimed' OR (state='uncertain' AND p_state='sent'))
    RETURNING * INTO n;
  IF NOT FOUND THEN RAISE EXCEPTION 'Notification delivery claim changed' USING ERRCODE='40001'; END IF;
  RETURN to_jsonb(n);
END $$;
CREATE FUNCTION public.pending_monthly_change_notifications(p_limit integer DEFAULT 20)
RETURNS SETOF public.member_monthly_change_notification LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.member_monthly_change_notification SET state='uncertain',updated_at=clock_timestamp(),
    evidence=jsonb_build_object('reason','delivery_claim_expired')
    WHERE state='claimed' AND claimed_at<clock_timestamp()-interval '10 minutes';
  RETURN QUERY SELECT * FROM public.member_monthly_change_notification
    WHERE state='pending' ORDER BY updated_at,operation_id LIMIT greatest(0,least(p_limit,100));
END $$;
REVOKE ALL ON FUNCTION public.queue_monthly_change_notification() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.claim_monthly_change_notification(uuid,uuid),
  public.finish_monthly_change_notification(uuid,uuid,uuid,text,jsonb),
  public.pending_monthly_change_notifications(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_monthly_change_notification(uuid,uuid),
  public.finish_monthly_change_notification(uuid,uuid,uuid,text,jsonb),
  public.pending_monthly_change_notifications(integer) TO service_role;
CREATE FUNCTION public.monthly_change_execution_available() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.monthly_change_execution_available() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.monthly_change_execution_available() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
