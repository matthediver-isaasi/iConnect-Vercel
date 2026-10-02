-- Bounded automatic evidence collection. Never modifies an existing snapshot,
-- provider IDs, write journals or settlement owner. Apply after 202611300002.
BEGIN;
CREATE TABLE IF NOT EXISTS public.event_invoice_reconstruction_attempt (
 operation_id uuid PRIMARY KEY REFERENCES public.event_invoice_recovery(id),
 attempted_at timestamptz NOT NULL DEFAULT now(),
 reason_code text
);
ALTER TABLE public.event_invoice_reconstruction_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_invoice_reconstruction_attempt FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.event_invoice_reconstruction_attempt TO service_role;

-- Specific automatic diagnostics must remain repairable by the existing
-- explicit finance approval path, not strand a row outside that authority.
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_historical_candidates(
 p_limit integer DEFAULT 20,p_tenant_id uuid DEFAULT NULL,p_source text DEFAULT NULL,p_group text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.event_invoice_recovery; result jsonb:='[]';
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
 OR (p_source IS NOT NULL AND p_source NOT IN ('booking','complex_event_booking'))
 OR (p_group IS NOT NULL AND (p_tenant_id IS NULL OR p_source IS NULL))
 THEN RAISE EXCEPTION 'Invalid historical candidate scope'; END IF;
 FOR r IN SELECT * FROM public.event_invoice_recovery
 WHERE snapshot IS NULL AND status='needs_review'
 AND (reason_code='snapshot_unavailable' OR reason_code LIKE 'historical_%')
 AND (p_tenant_id IS NULL OR tenant_id=p_tenant_id)
 AND (p_source IS NULL OR source=p_source) AND (p_group IS NULL OR booking_group_reference=p_group)
 ORDER BY created_at,id LIMIT p_limit LOOP
   result:=result || jsonb_build_array(jsonb_build_object(
     'operationId',r.id,'tenantId',r.tenant_id,'source',r.source,
     'bookingGroupReference',r.booking_group_reference,'operationUpdatedAt',r.updated_at,
     'bookingFingerprint',public.event_invoice_recovery_historical_fingerprint(r.tenant_id,r.source,r.booking_group_reference)));
 END LOOP;
 RETURN result;
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
 UPDATE public.event_invoice_recovery SET reason_code='snapshot_unavailable' WHERE id=r.id;
 INSERT INTO public.event_invoice_recovery_historical_evidence(operation_id,candidate,snapshot,evidence,state)
 VALUES(r.id,p_candidate,p_snapshot,p_evidence,'approved');
 RETURN jsonb_build_object('status','approved');
END $$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_automatic_input(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.event_invoice_recovery; bookings jsonb; ev jsonb; tickets jsonb;
 org jsonb; purchaser jsonb; providers jsonb; event_table text; event_id text;
BEGIN
 SELECT * INTO r FROM public.event_invoice_recovery WHERE id=p_id;
 IF NOT FOUND OR r.snapshot IS NOT NULL OR r.status<>'needs_review' THEN RETURN NULL; END IF;
 EXECUTE format('SELECT jsonb_agg(to_jsonb(b)-''invoice_recovery_status''-
   ''invoice_recovery_next_attempt_at'' ORDER BY id) FROM public.%I b
   WHERE tenant_id=$1 AND booking_group_reference=$2',r.source)
 INTO bookings USING r.tenant_id,r.booking_group_reference;
 event_id:=bookings#>>'{0,event_id}';
 event_table:=CASE WHEN r.source='booking' THEN 'event' ELSE 'complex_event' END;
 EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE id::text=$1 AND tenant_id=$2 FOR SHARE',event_table)
 INTO ev USING event_id,r.tenant_id;
 IF r.source='booking' THEN tickets:=coalesce(ev#>'{pricing_config,ticket_classes}','[]');
 ELSE
   SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') INTO tickets
   FROM (SELECT * FROM public.complex_event_ticket_class WHERE complex_event_id::text=event_id
     AND tenant_id=r.tenant_id FOR SHARE) t;
 END IF;
 SELECT jsonb_build_object('id',id,'tenant_id',tenant_id,'name',name,
   'invoicing_email',to_jsonb(o)->'invoicing_email','xero_contact_id',to_jsonb(o)->'xero_contact_id')
 INTO org FROM public.organization o WHERE id::text=bookings#>>'{0,organization_id}' AND tenant_id=r.tenant_id FOR SHARE;
 SELECT jsonb_build_object('id',id,'tenant_id',tenant_id,'first_name',first_name,
   'last_name',last_name,'email',email,'xero_contact_id',to_jsonb(m)->'xero_contact_id')
 INTO purchaser FROM public.member m WHERE id::text=bookings#>>'{0,member_id}' AND tenant_id=r.tenant_id FOR SHARE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'tenant_id',tenant_id) ORDER BY id),'[]')
 INTO providers FROM public.xero_token WHERE app_tenant_id=r.tenant_id;
 RETURN jsonb_build_object('candidate',jsonb_build_object(
   'operationId',r.id,'tenantId',r.tenant_id,'source',r.source,
   'bookingGroupReference',r.booking_group_reference,'operationUpdatedAt',r.updated_at,
   'bookingFingerprint',public.event_invoice_recovery_historical_fingerprint(r.tenant_id,r.source,r.booking_group_reference)),
   'bookings',bookings,'event',ev,'tickets',tickets,'organization',org,'member',purchaser,'providers',providers);
END $$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_automatic_candidates(
 p_limit integer DEFAULT 20,p_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r record; result jsonb:='[]';
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Invalid reconstruction bound'; END IF;
 FOR r IN SELECT q.id FROM public.event_invoice_recovery q
 LEFT JOIN public.event_invoice_reconstruction_attempt a ON a.operation_id=q.id
 WHERE q.snapshot IS NULL AND q.status='needs_review'
 AND (q.reason_code='snapshot_unavailable' OR q.reason_code LIKE 'historical_%')
 AND (p_id IS NULL OR q.id=p_id)
 AND (p_id IS NOT NULL OR a.attempted_at IS NULL OR a.attempted_at<now()-interval '1 day')
 AND NOT EXISTS(SELECT 1 FROM public.event_invoice_recovery_historical_evidence h WHERE h.operation_id=q.id)
 ORDER BY a.attempted_at NULLS FIRST,q.created_at,q.id LIMIT p_limit LOOP
   result:=result || jsonb_build_array(public.event_invoice_recovery_automatic_input(r.id));
 END LOOP;
 RETURN result;
END $$;

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
 -- Lock source rows while comparing original booking and supporting evidence.
 EXECUTE format('SELECT id FROM public.%I WHERE tenant_id=$1 AND booking_group_reference=$2 FOR SHARE',r.source)
 USING r.tenant_id,r.booking_group_reference;
 current_input:=public.event_invoice_recovery_automatic_input(r.id);
 IF current_input IS DISTINCT FROM p_input THEN RETURN jsonb_build_object('status','stale'); END IF;
 IF p_snapshot IS NULL THEN
   IF p_reason IS NULL OR p_reason !~ '^historical_[a-z_]+$' THEN RAISE EXCEPTION 'Invalid reconstruction reason'; END IF;
   UPDATE public.event_invoice_recovery SET reason_code=p_reason WHERE id=r.id;
 ELSE
   -- Existing reviewed authority performs validation, immutable promotion and
   -- booking/provider/ownership checks. No second accounting writer.
   UPDATE public.event_invoice_recovery SET reason_code='snapshot_unavailable' WHERE id=r.id;
   candidate:=public.event_invoice_recovery_automatic_input(r.id)->'candidate';
   evidence:=jsonb_build_object('version',1,'kind','original_booking_verified_provider','environment','live',
     'approvalReference','automatic-original-ticket-v1:'||r.id,'approvedBy','user-authorised-immutable-event-ticket-policy',
     'approvedAt',now(),'provenance',jsonb_build_array(
       'Original scoped booking rows: '||(candidate->>'bookingFingerprint'),
       'Explicit unchanged event ticket VAT and sales account; no account defaults',
       'Original booking purchaser foreign key; never attendee identity',
       'Original checkout Exclusive convention, booking date + 30 days, DRAFT invoice-only policy'));
   IF p_snapshot->>'paymentMethod'<>'invoice' THEN RAISE EXCEPTION 'Automatic settlement requires verified provider evidence'; END IF;
   PERFORM public.event_invoice_recovery_approve_historical(candidate,p_snapshot,evidence);
 END IF;
 INSERT INTO public.event_invoice_reconstruction_attempt(operation_id,attempted_at,reason_code)
 VALUES(r.id,now(),p_reason) ON CONFLICT(operation_id)
 DO UPDATE SET attempted_at=excluded.attempted_at,reason_code=excluded.reason_code;
 RETURN jsonb_build_object('status',CASE WHEN p_snapshot IS NULL THEN 'needs_review' ELSE 'approved' END);
END $$;

REVOKE ALL ON FUNCTION public.event_invoice_recovery_automatic_input(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.event_invoice_recovery_automatic_candidates(integer,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.event_invoice_recovery_automatic_commit(jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_invoice_recovery_automatic_candidates(integer,uuid),
 public.event_invoice_recovery_automatic_commit(jsonb,jsonb,text) TO service_role;
COMMIT;