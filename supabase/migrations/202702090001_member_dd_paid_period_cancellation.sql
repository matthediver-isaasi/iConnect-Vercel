-- Member-initiated Direct Debit cancellation at the end of the verified paid
-- period. Additive: administrator cancellation keeps its existing timing,
-- functions and blanket membership_cancelled access block. The member mode
-- reuses the same journal, events and scheduled lifecycle jobs, but:
--  * collections are fenced at confirmation (before access ends),
--  * the provider stop may be claimed before access ends,
--  * at the boundary the purchase is retired and the structure's DD fallback
--    role (captured at confirmation) is applied instead of a login block.
-- Requires 0047-0059 to be installed first (verified below).
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.withdraw_member_cancellation(uuid,uuid,uuid,uuid,text)') IS NULL
  OR to_regprocedure('public.guard_pending_cancellation_purchase()') IS NULL
  OR to_regprocedure('public.enqueue_member_cancellation_jobs()') IS NULL
  OR to_regprocedure('public.restore_membership_arrears_fallback_role(uuid,uuid)') IS NULL THEN
  RAISE EXCEPTION 'Install the reviewed cancellation journal (0047-0059) before member cancellation';
 END IF;
END $$;

LOCK TABLE public.member_cancellation_request IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.member_cancellation_request
 ADD COLUMN mode text NOT NULL DEFAULT 'administrator'
  CHECK(mode IN ('administrator','member_paid_period')),
 ADD COLUMN fallback_role_id uuid,
 ADD COLUMN previous_role_id uuid,
 ADD COLUMN role_outcome text
  CHECK(role_outcome IS NULL OR role_outcome IN ('applied','manual_change_preserved','administrator_preserved','already_assigned')),
 ADD COLUMN collections_fenced_at timestamptz,
 ADD COLUMN paid_through_date date,
 ADD CONSTRAINT member_cancellation_member_mode_shape CHECK(mode='administrator' OR (
  fallback_role_id IS NOT NULL AND collections_fenced_at IS NOT NULL AND paid_through_date IS NOT NULL
  AND paid_through_date<effective_date AND actor_id=member_id));
ALTER TABLE public.member_cancellation_request DROP CONSTRAINT member_cancellation_request_timing_check;
ALTER TABLE public.member_cancellation_request ADD CONSTRAINT member_cancellation_request_timing_check
 CHECK(timing IN ('immediate','end_of_term','paid_period') AND (timing='paid_period')=(mode='member_paid_period'));

-- Administrator access application must never apply a member-mode request:
-- that would impose the blanket login block this mode explicitly excludes.
DO $$
DECLARE fn regprocedure:='public.apply_member_cancellation_access(uuid,uuid,uuid,uuid)'::regprocedure;
 definition text; needle text:='IF r.access_ended_at IS NOT NULL THEN RETURN to_jsonb(r); END IF;';
BEGIN
 definition:=pg_get_functiondef(fn);
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Cancellation access contract needs review'; END IF;
 EXECUTE replace(definition,needle,needle||E'\n IF r.mode IS DISTINCT FROM ''administrator'' THEN RAISE EXCEPTION ''Member paid-period cancellation uses its own lifecycle''; END IF;');
END $$;

-- Withdrawal cannot undo a member's fenced collections or provider stop; a
-- member who wants to stay restarts through the normal renewal journey.
DO $$
DECLARE fn regprocedure:='public.withdraw_member_cancellation(uuid,uuid,uuid,uuid,text)'::regprocedure;
 definition text; needle text:='IF r.withdrawn_at IS NOT NULL THEN RETURN to_jsonb(r); END IF;';
BEGIN
 definition:=pg_get_functiondef(fn);
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Cancellation withdrawal contract needs review'; END IF;
 EXECUTE replace(definition,needle,needle||E'\n IF r.mode IS DISTINCT FROM ''administrator'' THEN RAISE EXCEPTION ''A member paid-period cancellation cannot be withdrawn''; END IF;');
END $$;

-- membership_cancelled reflects administrator cancellations only.
CREATE OR REPLACE FUNCTION public.guard_member_cancellation_access()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE blocked boolean;
BEGIN
 IF TG_OP='UPDATE' AND NEW.membership_cancelled IS NOT DISTINCT FROM OLD.membership_cancelled THEN RETURN NEW; END IF;
 SELECT EXISTS(SELECT 1 FROM public.member_cancellation_request r
  WHERE r.tenant_id=NEW.tenant_id AND r.member_id=NEW.id AND r.mode='administrator'
   AND r.access_ended_at IS NOT NULL AND r.cleared_at IS NULL AND r.withdrawn_at IS NULL) INTO blocked;
 IF NEW.membership_cancelled IS DISTINCT FROM blocked THEN
  RAISE EXCEPTION 'Membership cancellation access is controlled by its protected lifecycle';
 END IF;
 RETURN NEW;
END $$;
DO $$
DECLARE fn regprocedure:='public.clear_member_cancellation_for_new_purchase()'::regprocedure;
 definition text; needle text:='WHERE c.tenant_id=m.tenant_id AND c.member_id=m.id AND c.access_ended_at IS NOT NULL';
BEGIN
 definition:=pg_get_functiondef(fn);
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Cancellation clearing contract needs review'; END IF;
 EXECUTE replace(definition,needle,needle||' AND c.mode=''administrator''');
END $$;

-- Renewals keep their predecessor agreement unchanged. For member mode only,
-- a predecessor in the signed uninterrupted lineage is not a competing
-- purchase when every term it funded has ended and it has no live collection.
DO $$
DECLARE fn regprocedure:='public.guard_cancellation_admission_conflicts()'::regprocedure;
 definition text; needle text:=$n$AND a.id IS DISTINCT FROM (NEW.source_snapshot->>'billing_agreement_id')::uuid$n$;
BEGIN
 definition:=pg_get_functiondef(fn);
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Cancellation admission contract needs review'; END IF;
 EXECUTE replace(definition,needle,needle||$extra$
    AND NOT (NEW.mode='member_paid_period'
     AND jsonb_typeof(NEW.authority->'lineageAgreementIds')='array'
     AND NEW.authority->'lineageAgreementIds' ? a.id::text
     AND EXISTS(SELECT 1 FROM public.member_membership_history ph
      WHERE ph.tenant_id=a.tenant_id AND ph.member_id=a.member_id AND ph.billing_agreement_id=a.id)
     AND NOT EXISTS(SELECT 1 FROM public.member_membership_history ph
      WHERE ph.tenant_id=a.tenant_id AND ph.member_id=a.member_id AND ph.billing_agreement_id=a.id
       AND COALESCE(ph.status,'') NOT IN ('replaced','cancelled_by_request','expired_checkout','expired','failed')
       AND (ph.membership_renewal_date IS NULL OR ph.membership_renewal_date>current_date))
     AND NOT EXISTS(SELECT 1 FROM public.membership_payment_plans pp
      WHERE pp.tenant_id=a.tenant_id AND pp.billing_agreement_id=a.id
       AND pp.status IN ('active','paused','pending') AND pp.collection_stopped_at IS NULL))$extra$);
END $$;

-- Member provider-stop claims happen at confirmation, before access ends.
CREATE FUNCTION public.claim_member_dd_cancellation_provider_stop(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; s public.member_cancellation_provider_stop;
BEGIN
 IF p_actor_id IS NULL THEN RAISE EXCEPTION 'Audit actor required'; END IF;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR r.mode<>'member_paid_period' OR r.withdrawn_at IS NOT NULL OR r.collections_fenced_at IS NULL THEN
  RAISE EXCEPTION 'Confirmed member cancellation required before provider stop';
 END IF;
 SELECT * INTO s FROM public.member_cancellation_provider_stop
  WHERE id=r.id AND tenant_id=r.tenant_id AND member_id=r.member_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Provider stop journal missing'; END IF;
 IF s.state<>'pending' THEN RETURN jsonb_build_object('claimed',false,'operation',to_jsonb(s)); END IF;
 UPDATE public.member_cancellation_provider_stop SET state='claimed',
  claim_token=gen_random_uuid(),updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(r.id,p_actor_id,'provider_stop_claimed',jsonb_build_object('claimToken',s.claim_token));
 RETURN jsonb_build_object('claimed',true,'operation',to_jsonb(s));
END $$;

CREATE FUNCTION public.record_member_dd_cancellation_provider_stop(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid,p_claim_token uuid,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; s public.member_cancellation_provider_stop;
BEGIN
 IF p_actor_id IS NULL OR p_claim_token IS NULL OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
  OR NOT COALESCE(p_evidence->>'state' IN ('stopped','uncertain','active'),false)
 THEN RAISE EXCEPTION 'A scoped provider observation is required'; END IF;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR r.mode<>'member_paid_period' OR r.withdrawn_at IS NOT NULL THEN
  RAISE EXCEPTION 'Confirmed member cancellation required';
 END IF;
 SELECT * INTO s FROM public.member_cancellation_provider_stop
  WHERE id=r.id AND tenant_id=r.tenant_id AND member_id=r.member_id FOR UPDATE;
 IF NOT FOUND OR s.claim_token IS DISTINCT FROM p_claim_token
  OR s.state NOT IN ('claimed','uncertain','stopped') THEN RAISE EXCEPTION 'Stale cancellation claim'; END IF;
 IF p_evidence->>'subscriptionId' IS DISTINCT FROM s.prepared#>>'{authority,subscriptionId}' THEN
  RAISE EXCEPTION 'Provider observation belongs to another subscription';
 END IF;
 IF s.state='stopped' THEN RETURN to_jsonb(s); END IF;
 -- An "active" read after an unknown write is never a licence to resubmit.
 UPDATE public.member_cancellation_provider_stop SET
  state=CASE WHEN p_evidence->>'state'='stopped' THEN 'stopped' ELSE 'uncertain' END,
  evidence=p_evidence,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(r.id,p_actor_id,'provider_stop_observed',p_evidence);
 RETURN to_jsonb(s);
END $$;

CREATE FUNCTION public.begin_member_dd_paid_period_cancellation(
 p_tenant_id uuid,p_member_id uuid,p_key text,p_fingerprint text,p_authority jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; h public.member_membership_history; m public.member;
 source jsonb; agreement jsonb; plan jsonb; prepared jsonb; role_row public.role;
 effective date; paid_through date; configured uuid;
BEGIN
 IF p_key IS NULL OR p_key!~'^[A-Za-z0-9_.:-]{8,128}$'
  OR p_fingerprint IS NULL OR p_fingerprint!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(p_authority) IS DISTINCT FROM 'object'
  OR p_authority->>'mode' IS DISTINCT FROM 'member_paid_period'
  OR p_authority->>'tenantId' IS DISTINCT FROM p_tenant_id::text
  OR p_authority->>'memberId' IS DISTINCT FROM p_member_id::text
  OR p_authority->>'actorId' IS DISTINCT FROM p_member_id::text
  OR length(btrim(COALESCE(p_authority->>'reason',''))) NOT BETWEEN 1 AND 2000
  OR (p_authority->>'successfulCollections')::int < (p_authority->>'threshold')::int
 THEN RAISE EXCEPTION 'A signed, self-scoped member cancellation confirmation is required'; END IF;
 effective:=(p_authority->>'effectiveDate')::date;
 paid_through:=(p_authority->>'paidThroughDate')::date;
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 SELECT * INTO m FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owned member required'; END IF;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND request_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF r.fingerprint IS DISTINCT FROM p_fingerprint OR r.mode<>'member_paid_period' THEN
   RAISE EXCEPTION 'Cancellation key belongs to different evidence';
  END IF;
  RETURN to_jsonb(r);
 END IF;
 IF COALESCE(m.membership_cancelled,false) OR COALESCE((to_jsonb(m)->>'membership_paused')::boolean,false) THEN
  RAISE EXCEPTION 'Membership state changed; refresh cancellation';
 END IF;
 SELECT * INTO h FROM public.member_membership_history
  WHERE id=(p_authority#>>'{sourceSnapshot,id}')::uuid AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 source:=to_jsonb(h);
 IF h.id IS NULL OR source IS DISTINCT FROM p_authority->'sourceSnapshot'
  OR h.status IS DISTINCT FROM 'active' OR h.billing_agreement_id IS NULL
  OR h.term_start_date IS NULL OR h.term_start_date>current_date
  OR h.membership_renewal_date IS NULL OR h.membership_renewal_date<=current_date
  OR source->>'organization_id' IS NOT NULL OR source->>'membership_source'='organisation'
 THEN RAISE EXCEPTION 'Current personal purchase changed; refresh cancellation'; END IF;
 IF effective IS NULL OR paid_through IS NULL OR effective<=current_date
  OR effective>h.membership_renewal_date OR paid_through<>effective-1 OR effective<=h.term_start_date
 THEN RAISE EXCEPTION 'Paid-through date is not within the purchased term'; END IF;
 SELECT to_jsonb(a) INTO agreement FROM public.membership_billing_agreements a
  WHERE a.id=h.billing_agreement_id AND a.tenant_id=p_tenant_id AND a.member_id=p_member_id FOR UPDATE;
 SELECT to_jsonb(p) INTO plan FROM public.membership_payment_plans p
  WHERE p.id=(p_authority#>>'{planSnapshot,id}')::uuid AND p.billing_agreement_id=h.billing_agreement_id
   AND p.tenant_id=p_tenant_id AND p.member_id=p_member_id FOR UPDATE;
 IF agreement IS NULL OR plan IS NULL
  OR agreement IS DISTINCT FROM p_authority->'agreementSnapshot' OR plan IS DISTINCT FROM p_authority->'planSnapshot'
  OR agreement->>'agreement_type' IS DISTINCT FROM 'member' OR agreement->>'organization_id' IS NOT NULL
  OR plan->>'organization_id' IS NOT NULL OR agreement->>'provider' IS DISTINCT FROM 'gocardless'
  OR plan->>'provider' IS DISTINCT FROM 'gocardless' OR agreement->>'environment' IS DISTINCT FROM plan->>'environment'
  OR plan->>'collection_stopped_at' IS NOT NULL
 THEN RAISE EXCEPTION 'Owned Direct Debit plan changed'; END IF;
 prepared:=NULLIF(p_authority->'providerPrepared','null'::jsonb);
 IF prepared IS NULL THEN
  -- No provider stop is needed for a dynamic plan (no subscription) or a
  -- fixed plan whose subscription finished after every instalment was collected.
  IF NOT ((plan#>>'{metadata,collection_mode}' IS NOT DISTINCT FROM 'dynamic' AND plan->>'gocardless_subscription_id' IS NULL)
   OR (plan->>'status'='expired' AND plan->>'completed_at' IS NOT NULL
    AND NOT COALESCE((plan->>'needs_attention')::boolean,false))) THEN
   RAISE EXCEPTION 'Provider stop authority is missing';
  END IF;
 ELSIF prepared#>>'{authority,tenantId}' IS DISTINCT FROM p_tenant_id::text
  OR prepared#>>'{authority,memberId}' IS DISTINCT FROM p_member_id::text
  OR prepared#>>'{authority,agreementId}' IS DISTINCT FROM h.billing_agreement_id::text
  OR prepared#>>'{authority,provider}' IS DISTINCT FROM 'gocardless'
  OR prepared#>>'{authority,environment}' IS DISTINCT FROM plan->>'environment'
  OR prepared#>>'{authority,subscriptionId}' IS DISTINCT FROM plan->>'gocardless_subscription_id'
  OR prepared#>>'{authority,mandateId}' IS DISTINCT FROM COALESCE(plan->>'gocardless_mandate_id',agreement->>'gocardless_mandate_id')
 THEN RAISE EXCEPTION 'Provider authority differs from the purchased plan'; END IF;
 -- The fallback role is the structure's current DD setting, captured now.
 SELECT c.dd_arrears_fallback_role_id INTO configured FROM public.membership_tier_config c
  WHERE c.id=h.config_id AND c.tenant_id=p_tenant_id;
 SELECT * INTO role_row FROM public.role WHERE id=configured AND tenant_id=p_tenant_id;
 IF configured IS NULL OR role_row.id IS NULL OR COALESCE(role_row.is_tenant_admin,false)
  OR configured::text IS DISTINCT FROM p_authority->>'fallbackRoleId'
 THEN RAISE EXCEPTION 'The membership fallback role is missing or invalid'; END IF;
 INSERT INTO public.member_cancellation_request(tenant_id,member_id,source_record_id,actor_id,
  request_key,reason,effective_date,timing,source_snapshot,calculation,authority,fingerprint,
  mode,fallback_role_id,previous_role_id,collections_fenced_at,paid_through_date)
 VALUES(p_tenant_id,p_member_id,h.id,p_member_id,p_key,btrim(p_authority->>'reason'),effective,'paid_period',
  source,jsonb_build_object('action','cancel','sourceRecordId',h.id,'membershipEndExclusiveDate',effective,
   'threshold',(p_authority->>'threshold')::int,'successfulCollections',(p_authority->>'successfulCollections')::int,
   'collectionsInFlight',COALESCE((p_authority->>'collectionsInFlight')::int,0),
   'paymentReactivatesMembership',false,'accessWaitsForSettlement',false),
  p_authority,p_fingerprint,'member_paid_period',configured,m.role_id,clock_timestamp(),paid_through)
 RETURNING * INTO r;
 -- Fence new collections and renewal for this agreement now; paid access remains.
 UPDATE public.membership_payment_plans SET collection_stopped_at=COALESCE(collection_stopped_at,clock_timestamp())
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND billing_agreement_id=h.billing_agreement_id;
 IF prepared IS NOT NULL THEN
  INSERT INTO public.member_cancellation_provider_stop(id,tenant_id,member_id,prepared,fingerprint)
  VALUES(r.id,p_tenant_id,p_member_id,prepared,prepared->>'fingerprint');
  -- The provider stop must not wait for the paid-period boundary or for the
  -- member's browser: scheduled recovery picks it up immediately.
  UPDATE public.member_cancellation_job SET next_attempt_at=clock_timestamp()
   WHERE request_id=r.id AND kind='lifecycle' AND state='pending';
 END IF;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(r.id,p_member_id,'member_confirmed',jsonb_build_object('effectiveDate',effective,
  'paidThroughDate',paid_through,'fallbackRoleId',configured,'collectionsFenced',true,
  'providerStopConfirmed',false,'reason',r.reason));
 RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.apply_member_dd_paid_period_cancellation(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; h public.member_membership_history; m public.member;
 source jsonb; field_name text; outcome text; current_admin boolean;
BEGIN
 IF p_actor_id IS NULL THEN RAISE EXCEPTION 'Audit actor required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 SELECT * INTO m FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owned member required'; END IF;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR r.withdrawn_at IS NOT NULL OR r.mode<>'member_paid_period' THEN
  RAISE EXCEPTION 'Confirmed member cancellation required';
 END IF;
 IF r.access_ended_at IS NOT NULL THEN RETURN to_jsonb(r); END IF;
 IF r.effective_date>current_date THEN RAISE EXCEPTION 'Cancellation is not yet effective'; END IF;
 SELECT * INTO h FROM public.member_membership_history WHERE id=r.source_record_id
  AND tenant_id=r.tenant_id AND member_id=r.member_id FOR UPDATE;
 source:=to_jsonb(h);
 IF h.id IS NULL OR NOT COALESCE(h.status IN ('active','expired'),false) THEN
  RAISE EXCEPTION 'Cancellation purchase changed';
 END IF;
 FOREACH field_name IN ARRAY ARRAY['id','tenant_id','member_id','config_id','band_id',
  'billing_agreement_id','term_key','term_start_date','membership_renewal_date','commitment_snapshot']
 LOOP
  IF source->field_name IS DISTINCT FROM r.source_snapshot->field_name THEN
   RAISE EXCEPTION 'Signed cancellation purchase changed';
  END IF;
 END LOOP;
 UPDATE public.member_cancellation_request SET access_ended_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
 UPDATE public.member_membership_history SET status='cancelled_by_request' WHERE id=h.id;
 -- Compare-and-set: only the role held at confirmation is replaced. Team or
 -- administrator roles and later manual changes are preserved.
 SELECT COALESCE(is_tenant_admin,false) INTO current_admin FROM public.role WHERE id=m.role_id AND tenant_id=p_tenant_id;
 IF m.role_id IS NOT DISTINCT FROM r.fallback_role_id THEN outcome:='already_assigned';
 ELSIF COALESCE(current_admin,false) THEN outcome:='administrator_preserved';
 ELSIF m.role_id IS DISTINCT FROM r.previous_role_id THEN outcome:='manual_change_preserved';
 ELSE
  UPDATE public.member SET role_id=r.fallback_role_id WHERE id=m.id AND tenant_id=p_tenant_id;
  outcome:='applied';
 END IF;
 UPDATE public.member_cancellation_request SET role_outcome=outcome WHERE id=r.id RETURNING * INTO r;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(r.id,p_actor_id,'access_ended',jsonb_build_object('effectiveDate',r.effective_date,
  'mode',r.mode,'roleOutcome',outcome,'fallbackRoleId',r.fallback_role_id,
  'loginBlocked',false,'debtPreserved',true));
 RETURN to_jsonb(r);
END $$;

-- Member-mode financial outcome: the paid period was fully funded, so a clean
-- outcome needs no balance change. Late or in-flight receipts go to review.
CREATE FUNCTION public.record_member_dd_cancellation_finance(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid,p_state text,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request;
BEGIN
 IF p_actor_id IS NULL OR p_state NOT IN ('settled','manual_review') OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'A scoped financial observation is required';
 END IF;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR r.mode<>'member_paid_period' OR r.access_ended_at IS NULL THEN
  RAISE EXCEPTION 'Applied member cancellation required';
 END IF;
 IF r.financial_state IN ('settled','manual_review') THEN RETURN to_jsonb(r); END IF;
 UPDATE public.member_cancellation_request SET financial_state=p_state WHERE id=r.id RETURNING * INTO r;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(r.id,p_actor_id,'finance_observed',p_evidence||jsonb_build_object('state',p_state));
 RETURN to_jsonb(r);
END $$;

-- Collections stay fenced while a member-mode cancellation is not withdrawn.
CREATE FUNCTION public.guard_member_dd_cancellation_collections()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.collection_stopped_at IS NOT NULL AND NEW.collection_stopped_at IS NULL
  AND EXISTS(SELECT 1 FROM public.member_cancellation_request r
   JOIN public.member_membership_history h ON h.id=r.source_record_id
   WHERE r.tenant_id=NEW.tenant_id AND r.member_id=NEW.member_id AND r.mode='member_paid_period'
    AND r.withdrawn_at IS NULL AND h.billing_agreement_id=NEW.billing_agreement_id) THEN
  RAISE EXCEPTION 'A member cancellation has stopped collections for this membership';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_member_dd_cancellation_collections BEFORE UPDATE OF collection_stopped_at
 ON public.membership_payment_plans FOR EACH ROW EXECUTE FUNCTION public.guard_member_dd_cancellation_collections();

-- An automatic continuation of a cancelled agreement cannot be created, even
-- after the boundary when the pending-purchase guard no longer applies.
CREATE FUNCTION public.guard_member_dd_cancellation_renewal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE previous text:=COALESCE(NEW.metadata#>>'{dd,renewal_of_agreement_id}',NEW.metadata->>'renewal_of_agreement_id');
BEGIN
 IF previous IS NOT NULL AND EXISTS(SELECT 1 FROM public.member_cancellation_request r
  JOIN public.member_membership_history h ON h.id=r.source_record_id
  WHERE r.tenant_id=NEW.tenant_id AND r.member_id=NEW.member_id AND r.mode='member_paid_period'
   AND r.withdrawn_at IS NULL AND h.billing_agreement_id::text=previous) THEN
  RAISE EXCEPTION 'This membership was cancelled by the member and cannot be renewed automatically';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_member_dd_cancellation_renewal BEFORE INSERT ON public.membership_billing_agreements
 FOR EACH ROW EXECUTE FUNCTION public.guard_member_dd_cancellation_renewal();

-- Readiness probe for the server: true only when this contract is installed.
CREATE FUNCTION public.member_dd_cancellation_available() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION public.claim_member_dd_cancellation_provider_stop(uuid,uuid,uuid,uuid),
 public.record_member_dd_cancellation_provider_stop(uuid,uuid,uuid,uuid,uuid,jsonb),
 public.begin_member_dd_paid_period_cancellation(uuid,uuid,text,text,jsonb),
 public.apply_member_dd_paid_period_cancellation(uuid,uuid,uuid,uuid),
 public.record_member_dd_cancellation_finance(uuid,uuid,uuid,uuid,text,jsonb),
 public.guard_member_dd_cancellation_collections(),public.guard_member_dd_cancellation_renewal(),
 public.member_dd_cancellation_available()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_member_dd_cancellation_provider_stop(uuid,uuid,uuid,uuid),
 public.record_member_dd_cancellation_provider_stop(uuid,uuid,uuid,uuid,uuid,jsonb),
 public.begin_member_dd_paid_period_cancellation(uuid,uuid,text,text,jsonb),
 public.apply_member_dd_paid_period_cancellation(uuid,uuid,uuid,uuid),
 public.record_member_dd_cancellation_finance(uuid,uuid,uuid,uuid,text,jsonb),
 public.member_dd_cancellation_available() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
