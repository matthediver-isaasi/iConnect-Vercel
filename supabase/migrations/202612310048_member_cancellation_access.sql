-- Access termination is independent of receivable/provider settlement.
-- No public readiness function or request-creation entry point is enabled here.
BEGIN;
ALTER TABLE public.member ADD COLUMN membership_cancelled boolean NOT NULL DEFAULT false;
ALTER TABLE public.member_cancellation_request
 ADD COLUMN cleared_by_history_id uuid REFERENCES public.member_membership_history(id),
 ADD COLUMN cleared_at timestamptz,
 ADD COLUMN withdrawn_at timestamptz;
CREATE TABLE public.member_cancellation_purchase_candidate (
 request_id uuid NOT NULL REFERENCES public.member_cancellation_request(id),
 history_id uuid NOT NULL REFERENCES public.member_membership_history(id),
 PRIMARY KEY(request_id,history_id)
);
ALTER TABLE public.member_cancellation_purchase_candidate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_cancellation_purchase_candidate FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_cancellation_purchase_candidate TO service_role;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_cancellation_purchase_candidate
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();

CREATE FUNCTION public.guard_member_cancellation_access()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE blocked boolean;
BEGIN
 IF TG_OP='UPDATE' AND NEW.membership_cancelled IS NOT DISTINCT FROM OLD.membership_cancelled THEN RETURN NEW; END IF;
 SELECT EXISTS(SELECT 1 FROM public.member_cancellation_request r
  WHERE r.tenant_id=NEW.tenant_id AND r.member_id=NEW.id
   AND r.access_ended_at IS NOT NULL AND r.cleared_at IS NULL AND r.withdrawn_at IS NULL) INTO blocked;
 IF NEW.membership_cancelled IS DISTINCT FROM blocked THEN
  RAISE EXCEPTION 'Membership cancellation access is controlled by its protected lifecycle';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_cancellation_access BEFORE INSERT OR UPDATE OF membership_cancelled ON public.member
 FOR EACH ROW EXECUTE FUNCTION public.guard_member_cancellation_access();

CREATE FUNCTION public.guard_member_cancellation_retirement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status='cancelled_by_request' AND NEW.status IS DISTINCT FROM OLD.status THEN
  RAISE EXCEPTION 'Payment cannot reactivate a cancelled purchase';
 END IF;
 IF NEW.status='cancelled_by_request' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
  IF TG_OP='INSERT' OR NOT EXISTS(SELECT 1 FROM public.member_cancellation_request r
   WHERE r.tenant_id=NEW.tenant_id AND r.member_id=NEW.member_id AND r.source_record_id=NEW.id
    AND r.access_ended_at IS NOT NULL AND r.withdrawn_at IS NULL) THEN
   RAISE EXCEPTION 'An applied cancellation is required to retire this purchase';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_cancellation_retirement BEFORE INSERT OR UPDATE OF status ON public.member_membership_history
 FOR EACH ROW EXECUTE FUNCTION public.guard_member_cancellation_retirement();

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.member_membership_history WHERE status='cancelled_by_request') THEN
  RAISE EXCEPTION 'Existing cancellation retirement states require provenance review';
 END IF;
END $$;
ALTER TABLE public.member_membership_history DROP CONSTRAINT member_membership_history_rolling_no_overlap;
ALTER TABLE public.member_membership_history ADD CONSTRAINT member_membership_history_rolling_no_overlap
 EXCLUDE USING gist(tenant_id WITH =,member_id WITH =,daterange(term_start_date,membership_renewal_date,'[)') WITH &&)
 WHERE(term_key IS NOT NULL AND status IS DISTINCT FROM 'replaced' AND status IS DISTINCT FROM 'cancelled_by_request');
DO $$
DECLARE body text; needle text:=$n$AND q.id IS DISTINCT FROM (payment_quote->>'id')::uuid$n$;
BEGIN
 body:=pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure);
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'Rolling checkout reservation contract needs review'; END IF;
 body:=replace(body,needle,needle||$extra$
         AND NOT EXISTS(
           SELECT 1 FROM public.member_cancellation_request cancelled
           JOIN public.member_membership_history original ON original.id=cancelled.source_record_id
            AND original.tenant_id=cancelled.tenant_id AND original.member_id=cancelled.member_id
           WHERE cancelled.tenant_id=q.tenant_id AND cancelled.member_id=q.member_id
            AND cancelled.access_ended_at IS NOT NULL AND cancelled.withdrawn_at IS NULL
            AND q.organization_id IS NULL AND original.status='cancelled_by_request'
            AND (to_jsonb(original)->>'membership_payment_quote_id'=q.id::text
             OR (q.stripe_payment_intent_id IS NOT NULL
              AND to_jsonb(original)->>'stripe_payment_intent_id'=q.stripe_payment_intent_id)))
 $extra$);
 EXECUTE body;
END $$;

CREATE FUNCTION public.apply_member_cancellation_access(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; h public.member_membership_history; source jsonb; field_name text;
BEGIN
 IF p_actor_id IS NULL THEN RAISE EXCEPTION 'Audit actor required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owned member required'; END IF;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR r.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'Approved cancellation required'; END IF;
 IF r.access_ended_at IS NOT NULL THEN RETURN to_jsonb(r); END IF;
 IF r.effective_date>current_date THEN RAISE EXCEPTION 'Cancellation is not yet effective'; END IF;
 SELECT * INTO h FROM public.member_membership_history WHERE id=r.source_record_id
  AND tenant_id=r.tenant_id AND member_id=r.member_id FOR UPDATE;
 source:=to_jsonb(h);
 IF h.id IS NULL OR NOT COALESCE(h.status IN ('active','expired'),false)
  OR source->>'organization_id' IS NOT NULL OR source->>'membership_source'='organisation'
  OR r.calculation->>'action' IS DISTINCT FROM 'cancel'
  OR r.calculation->>'sourceRecordId' IS DISTINCT FROM h.id::text
  OR r.calculation->>'membershipEndExclusiveDate' IS DISTINCT FROM r.effective_date::text
  OR (r.timing='immediate' AND (
   r.calculation->>'accessWaitsForSettlement' IS DISTINCT FROM 'false'
   OR r.calculation->>'paymentReactivatesMembership' IS DISTINCT FROM 'false'
   OR r.calculation->>'cancellationChargeBasis' IS DISTINCT FROM 'service_used'))
  OR (r.timing='end_of_term' AND r.effective_date IS DISTINCT FROM h.membership_renewal_date)
 THEN RAISE EXCEPTION 'Cancellation purchase or approved access policy changed'; END IF;
 -- Scheduled cancellation may race ordinary expiry or receipt enrichment.
 -- Those do not authorize extra service. Preserve the signed purchase identity
 -- while allowing non-contractual status/accounting fields to be reconciled.
 FOREACH field_name IN ARRAY ARRAY['id','tenant_id','member_id','config_id','band_id',
  'billing_agreement_id','term_key','term_start_date','membership_renewal_date','commitment_snapshot']
 LOOP
  IF source->field_name IS DISTINCT FROM r.source_snapshot->field_name THEN
   RAISE EXCEPTION 'Signed cancellation purchase changed';
  END IF;
 END LOOP;
 -- This marker is neither provider-stop proof nor financial settlement proof.
 UPDATE public.member_cancellation_request SET access_ended_at=clock_timestamp()
  WHERE id=r.id RETURNING * INTO r;
 UPDATE public.member_membership_history SET status='cancelled_by_request' WHERE id=h.id;
 UPDATE public.member SET membership_cancelled=true WHERE id=r.member_id AND tenant_id=r.tenant_id;
 IF h.billing_agreement_id IS NOT NULL THEN
  UPDATE public.membership_payment_plans
   SET collection_stopped_at=COALESCE(collection_stopped_at,clock_timestamp())
   WHERE tenant_id=r.tenant_id AND member_id=r.member_id AND billing_agreement_id=h.billing_agreement_id;
 END IF;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(r.id,p_actor_id,'access_ended',jsonb_build_object('effectiveDate',r.effective_date,
  'debtPreserved',true,'providerStopConfirmed',false));
 RETURN to_jsonb(r);
END $$;

-- Only a distinct, currently paid purchase can clear cancellation access.
-- An old invoice settling or the old history being updated is insufficient.
CREATE FUNCTION public.clear_member_cancellation_for_new_purchase()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request;
BEGIN
 IF TG_OP='INSERT' AND to_jsonb(NEW)->>'organization_id' IS NULL
  AND (to_jsonb(NEW)->>'membership_source') IS DISTINCT FROM 'organisation' THEN
  INSERT INTO public.member_cancellation_purchase_candidate(request_id,history_id)
   SELECT pending_request.id,NEW.id FROM public.member_cancellation_request pending_request
   WHERE pending_request.tenant_id=NEW.tenant_id AND pending_request.member_id=NEW.member_id
    AND pending_request.access_ended_at IS NOT NULL AND pending_request.cleared_at IS NULL AND pending_request.withdrawn_at IS NULL
    AND pending_request.source_record_id<>NEW.id AND pending_request.effective_date<=NEW.term_start_date
   ON CONFLICT DO NOTHING;
 END IF;
 IF NEW.status IS DISTINCT FROM 'active' OR NEW.payment_status IS DISTINCT FROM 'paid'
  OR to_jsonb(NEW)->>'organization_id' IS NOT NULL OR NEW.term_key IS NULL
  OR to_jsonb(NEW)->>'membership_source'='organisation'
  OR NEW.term_start_date>current_date OR NEW.membership_renewal_date<=current_date THEN RETURN NEW; END IF;
 FOR r IN SELECT * FROM public.member_cancellation_request
  WHERE tenant_id=NEW.tenant_id AND member_id=NEW.member_id AND access_ended_at IS NOT NULL
   AND cleared_at IS NULL AND withdrawn_at IS NULL AND source_record_id<>NEW.id
   AND effective_date<=NEW.term_start_date
   AND EXISTS(SELECT 1 FROM public.member_cancellation_purchase_candidate candidate
    WHERE candidate.request_id=member_cancellation_request.id AND candidate.history_id=NEW.id)
   FOR UPDATE
 LOOP
  UPDATE public.member_cancellation_request SET cleared_by_history_id=NEW.id,cleared_at=clock_timestamp() WHERE id=r.id;
  INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
  VALUES(r.id,r.actor_id,'new_paid_purchase',jsonb_build_object('historyId',NEW.id,'originalDebtUnaffected',true));
 END LOOP;
 UPDATE public.member m SET membership_cancelled=false
  WHERE m.id=NEW.member_id AND m.tenant_id=NEW.tenant_id AND m.membership_cancelled
   AND NOT EXISTS(SELECT 1 FROM public.member_cancellation_request c
    WHERE c.tenant_id=m.tenant_id AND c.member_id=m.id AND c.access_ended_at IS NOT NULL
     AND c.cleared_at IS NULL AND c.withdrawn_at IS NULL);
 RETURN NEW;
END $$;
CREATE TRIGGER member_cancellation_new_purchase AFTER INSERT OR UPDATE OF status,payment_status ON public.member_membership_history
 FOR EACH ROW EXECUTE FUNCTION public.clear_member_cancellation_for_new_purchase();
REVOKE ALL ON FUNCTION public.guard_member_cancellation_access(),public.guard_member_cancellation_retirement(),
 public.clear_member_cancellation_for_new_purchase(),public.apply_member_cancellation_access(uuid,uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.apply_member_cancellation_access(uuid,uuid,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
