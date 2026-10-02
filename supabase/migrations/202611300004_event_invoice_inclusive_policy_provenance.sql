-- 003 remains unchanged for deployments already applying it. Record the
-- explicit ticket policy, rather than falsely describing Inclusive as Exclusive.
BEGIN;
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
   UPDATE public.event_invoice_recovery SET reason_code=p_reason WHERE id=r.id;
 ELSE
   UPDATE public.event_invoice_recovery SET reason_code='snapshot_unavailable' WHERE id=r.id;
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
REVOKE ALL ON FUNCTION public.event_invoice_recovery_automatic_commit(jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_invoice_recovery_automatic_commit(jsonb,jsonb,text) TO service_role;
COMMIT;