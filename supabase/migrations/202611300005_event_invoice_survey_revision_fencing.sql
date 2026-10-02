BEGIN;
-- This exclusion belongs ONLY to invoice history. Survey invitation fencing
-- continues to use its own revision unchanged.
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_historical_fingerprint(
 p_tenant_id uuid,p_source text,p_group text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE fingerprint text;
BEGIN
 IF p_source NOT IN ('booking','complex_event_booking') THEN RAISE EXCEPTION 'Invalid historical source'; END IF;
 EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(b)-''invoice_recovery_status''-
 ''invoice_recovery_next_attempt_at''-''survey_invitation_revision'' ORDER BY b.id),''[]''::jsonb)::text)
 FROM public.%I b WHERE tenant_id=$1 AND booking_group_reference=$2',p_source)
 INTO fingerprint USING p_tenant_id,p_group;
 RETURN fingerprint;
END $$;

-- A reason/lease-only operation update must not UPDATE the booking at all.
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 EXECUTE format('UPDATE public.%I SET invoice_recovery_status=$1,
 invoice_recovery_next_attempt_at=$2 WHERE tenant_id=$3 AND booking_group_reference=$4
 AND (invoice_recovery_status,invoice_recovery_next_attempt_at) IS DISTINCT FROM ($1,$2)',NEW.source)
 USING NEW.status,NEW.next_attempt_at,NEW.tenant_id,NEW.booking_group_reference;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_approve_historical(
 p_candidate jsonb,p_snapshot jsonb,p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.event_invoice_recovery; prior public.event_invoice_recovery_historical_evidence;
BEGIN
 IF NOT public.event_invoice_recovery_historical_valid(p_snapshot,p_evidence)
 THEN RAISE EXCEPTION 'Invalid approved historical evidence'; END IF;
 SELECT * INTO r FROM public.event_invoice_recovery WHERE id=(p_candidate->>'operationId')::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Historical operation not found'; END IF;
 SELECT * INTO prior FROM public.event_invoice_recovery_historical_evidence WHERE operation_id=r.id;
 IF FOUND THEN
   IF prior.candidate=p_candidate AND prior.snapshot=p_snapshot AND prior.evidence=p_evidence
   THEN RETURN jsonb_build_object('status','already_approved'); END IF;
   RAISE EXCEPTION 'Historical evidence already pinned';
 END IF;
 IF r.snapshot IS NOT NULL OR r.status<>'needs_review'
 OR NOT (r.reason_code='snapshot_unavailable' OR r.reason_code LIKE 'historical_%')
 OR r.tenant_id::text IS DISTINCT FROM p_candidate->>'tenantId'
 OR r.source IS DISTINCT FROM p_candidate->>'source'
 OR r.booking_group_reference IS DISTINCT FROM p_candidate->>'bookingGroupReference'
 OR r.updated_at IS DISTINCT FROM (p_candidate->>'operationUpdatedAt')::timestamptz
 OR public.event_invoice_recovery_historical_fingerprint(r.tenant_id,r.source,r.booking_group_reference)
    IS DISTINCT FROM p_candidate->>'bookingFingerprint'
 THEN RAISE EXCEPTION 'Historical candidate stale'; END IF;
 UPDATE public.event_invoice_recovery SET reason_code='snapshot_unavailable'
 WHERE id=r.id AND reason_code IS DISTINCT FROM 'snapshot_unavailable';
 INSERT INTO public.event_invoice_recovery_historical_evidence(operation_id,candidate,snapshot,evidence,state)
 VALUES(r.id,p_candidate,p_snapshot,p_evidence,'approved');
 RETURN jsonb_build_object('status','approved');
END $$;

-- Preserve 004's Inclusive provenance while avoiding no-op reason writes.
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_automatic_commit(
 p_input jsonb,p_snapshot jsonb DEFAULT NULL,p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.event_invoice_recovery; current_input jsonb; candidate jsonb; evidence jsonb;
BEGIN
 SELECT * INTO r FROM public.event_invoice_recovery
 WHERE id=(p_input#>>'{candidate,operationId}')::uuid FOR UPDATE;
 IF NOT FOUND OR r.snapshot IS NOT NULL OR r.status<>'needs_review'
 OR EXISTS(SELECT 1 FROM public.event_invoice_recovery_historical_evidence WHERE operation_id=r.id)
 THEN RETURN jsonb_build_object('status','stale'); END IF;
 EXECUTE format('SELECT id FROM public.%I WHERE tenant_id=$1 AND booking_group_reference=$2 FOR SHARE',r.source)
 USING r.tenant_id,r.booking_group_reference;
 current_input:=public.event_invoice_recovery_automatic_input(r.id);
 IF current_input IS DISTINCT FROM p_input THEN RETURN jsonb_build_object('status','stale'); END IF;
 IF p_snapshot IS NULL THEN
   IF p_reason IS NULL OR p_reason !~ '^historical_[a-z_]+$' THEN RAISE EXCEPTION 'Invalid reconstruction reason'; END IF;
   UPDATE public.event_invoice_recovery SET reason_code=p_reason WHERE id=r.id AND reason_code IS DISTINCT FROM p_reason;
 ELSE
   UPDATE public.event_invoice_recovery SET reason_code='snapshot_unavailable'
   WHERE id=r.id AND reason_code IS DISTINCT FROM 'snapshot_unavailable';
   candidate:=public.event_invoice_recovery_automatic_input(r.id)->'candidate';
   evidence:=jsonb_build_object('version',1,'kind','original_booking_verified_provider','environment','live',
     'approvalReference','automatic-original-ticket-v1:'||r.id,'approvedBy','user-authorised-immutable-event-ticket-policy',
     'approvedAt',now(),'provenance',jsonb_build_array(
       'Original scoped booking rows: '||(candidate->>'bookingFingerprint'),
       'Explicit unchanged event ticket VAT and sales account; no account defaults',
       'Original booking purchaser foreign key; never attendee identity',
       CASE WHEN p_snapshot#>>'{invoice,LineAmountTypes}'='Inclusive'
         THEN 'Explicit ticket invoice_line_amount_type=Inclusive; recorded booking amount is gross'
         ELSE 'Exclusive ticket policy or original checkout Exclusive convention' END,
       'Booking date + 30 days, DRAFT invoice-only policy'));
   IF p_snapshot->>'paymentMethod'<>'invoice' THEN RAISE EXCEPTION 'Automatic settlement requires verified provider evidence'; END IF;
   PERFORM public.event_invoice_recovery_approve_historical(candidate,p_snapshot,evidence);
 END IF;
 INSERT INTO public.event_invoice_reconstruction_attempt(operation_id,attempted_at,reason_code)
 VALUES(r.id,now(),p_reason) ON CONFLICT(operation_id)
 DO UPDATE SET attempted_at=excluded.attempted_at,reason_code=excluded.reason_code;
 RETURN jsonb_build_object('status',CASE WHEN p_snapshot IS NULL THEN 'needs_review' ELSE 'approved' END);
END $$;

CREATE TABLE IF NOT EXISTS public.event_invoice_recovery_readmission_audit(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operation_id uuid NOT NULL REFERENCES public.event_invoice_recovery(id),
 rejected_record jsonb NOT NULL,
 original_survey_revisions jsonb NOT NULL,
 replacement_candidate jsonb NOT NULL,
 repair_reference text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.event_invoice_recovery_readmission_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_invoice_recovery_readmission_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.event_invoice_recovery_readmission_audit TO service_role;
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_readmission_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'Readmission audit is append only'; END $$;
DROP TRIGGER IF EXISTS event_invoice_recovery_readmission_append_only ON public.event_invoice_recovery_readmission_audit;
CREATE TRIGGER event_invoice_recovery_readmission_append_only BEFORE UPDATE OR DELETE
ON public.event_invoice_recovery_readmission_audit FOR EACH ROW
EXECUTE FUNCTION public.event_invoice_recovery_readmission_append_only();

-- Re-admit ONLY a rejected, never-written invoice-only manifest. The caller
-- supplies the ENTIRE expected rejected row and original per-booking survey
-- revisions. Recreating the OLD fingerprint substitutes only those revisions;
-- every other financial/purchaser/booking field must match the original MD5.
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_readmit_survey_stale(
 p_id uuid,p_expected_rejected jsonb,p_original_survey_revisions jsonb,p_repair_reference text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE h public.event_invoice_recovery_historical_evidence; r public.event_invoice_recovery;
 rows_now jsonb; b jsonb; legacy_rows jsonb:='[]'; revision jsonb; v_candidate jsonb; audit_id uuid; safe boolean;
BEGIN
 IF nullif(trim(p_repair_reference),'') IS NULL OR length(p_repair_reference)>500
 OR jsonb_typeof(p_original_survey_revisions) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'Invalid audited readmission scope'; END IF;
 SELECT * INTO h FROM public.event_invoice_recovery_historical_evidence WHERE operation_id=p_id FOR UPDATE;
 IF NOT FOUND OR to_jsonb(h) IS DISTINCT FROM p_expected_rejected
 OR h.state<>'rejected' OR h.reason_code<>'historical_candidate_stale' OR h.consumed_at IS NOT NULL
 OR h.snapshot->>'paymentMethod' IS DISTINCT FROM 'invoice'
 OR NOT public.event_invoice_recovery_historical_valid(h.snapshot,h.evidence)
 THEN RAISE EXCEPTION 'Exact rejected invoice evidence required'; END IF;
 SELECT * INTO r FROM public.event_invoice_recovery WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR r.snapshot IS NOT NULL OR r.status<>'needs_review' OR r.reason_code<>'snapshot_unavailable'
 OR r.invoice_id IS NOT NULL OR r.invoice_number IS NOT NULL OR r.payment_id IS NOT NULL
 OR r.invoice_write_started_at IS NOT NULL OR r.payment_write_started_at IS NOT NULL
 OR r.settlement_payment_intent_id IS NOT NULL OR r.attempts<>0
 OR r.lease_token IS NOT NULL OR r.lease_expires_at IS NOT NULL
 OR r.updated_at IS DISTINCT FROM (h.candidate->>'operationUpdatedAt')::timestamptz
 OR r.tenant_id::text IS DISTINCT FROM h.candidate->>'tenantId'
 OR r.source IS DISTINCT FROM h.candidate->>'source'
 OR r.booking_group_reference IS DISTINCT FROM h.candidate->>'bookingGroupReference'
 THEN RAISE EXCEPTION 'Operation is not safe for survey-only readmission'; END IF;
 EXECUTE format('SELECT id FROM public.%I WHERE tenant_id=$1 AND booking_group_reference=$2 FOR UPDATE',r.source)
 USING r.tenant_id,r.booking_group_reference;
 EXECUTE format('SELECT jsonb_agg(to_jsonb(b)-''invoice_recovery_status''-
 ''invoice_recovery_next_attempt_at'' ORDER BY id),bool_and(coalesce(
 public.event_invoice_recovery_eligible(to_jsonb(b)) AND payment_method IN (''invoice'',''account'')
 AND coalesce(to_jsonb(b)->>''payment_status'','''') NOT IN (''refunded'',''failed'',''cancelled'')
 AND nullif(to_jsonb(b)->>''stripe_payment_intent_id'','''') IS NULL,false))
 FROM public.%I b WHERE tenant_id=$1 AND booking_group_reference=$2',r.source)
 INTO rows_now,safe USING r.tenant_id,r.booking_group_reference;
 IF NOT coalesce(safe,false) OR coalesce(jsonb_array_length(rows_now),0)=0
 OR (SELECT count(*) FROM jsonb_object_keys(p_original_survey_revisions))<>jsonb_array_length(rows_now)
 THEN RAISE EXCEPTION 'Exact eligible booking revisions required'; END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(rows_now) LOOP
   revision:=p_original_survey_revisions->(b->>'id');
   IF jsonb_typeof(revision) IS DISTINCT FROM 'number' OR revision::text !~ '^[0-9]+$'
   OR NOT b ? 'survey_invitation_revision'
   OR (revision::text)::numeric>(b->>'survey_invitation_revision')::numeric
   THEN RAISE EXCEPTION 'Invalid original survey revision'; END IF;
   legacy_rows:=legacy_rows||jsonb_build_array(jsonb_set(b,'{survey_invitation_revision}',revision));
 END LOOP;
 IF md5(legacy_rows::text) IS DISTINCT FROM h.candidate->>'bookingFingerprint'
 THEN RAISE EXCEPTION 'Original financial/purchaser fingerprint changed'; END IF;
 v_candidate:=h.candidate||jsonb_build_object('bookingFingerprint',
   public.event_invoice_recovery_historical_fingerprint(r.tenant_id,r.source,r.booking_group_reference));
 INSERT INTO public.event_invoice_recovery_readmission_audit(
   operation_id,rejected_record,original_survey_revisions,replacement_candidate,repair_reference)
 VALUES(p_id,to_jsonb(h),p_original_survey_revisions,v_candidate,p_repair_reference) RETURNING id INTO audit_id;
 UPDATE public.event_invoice_recovery_historical_evidence SET candidate=v_candidate,
   state='approved',reason_code=NULL WHERE operation_id=p_id;
 RETURN jsonb_build_object('status','approved','auditId',audit_id,'candidate',v_candidate);
END $$;

REVOKE ALL ON FUNCTION public.event_invoice_recovery_historical_fingerprint(uuid,text,text),
 public.event_invoice_recovery_mirror(),
 public.event_invoice_recovery_approve_historical(jsonb,jsonb,jsonb),
 public.event_invoice_recovery_automatic_commit(jsonb,jsonb,text),
 public.event_invoice_recovery_readmission_append_only(),
 public.event_invoice_recovery_readmit_survey_stale(uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_invoice_recovery_readmit_survey_stale(uuid,jsonb,jsonb,text) TO service_role;
COMMIT;