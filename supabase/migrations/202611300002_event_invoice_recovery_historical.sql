-- One-time hydration from protected, explicitly approved historical evidence.
-- No current catalogue, purchaser, tax settings or payment-mode inference.
BEGIN;
CREATE TABLE IF NOT EXISTS public.event_invoice_recovery_historical_evidence (
 operation_id uuid PRIMARY KEY REFERENCES public.event_invoice_recovery(id),
 candidate jsonb NOT NULL,
 snapshot jsonb NOT NULL,
 evidence jsonb NOT NULL,
 state text NOT NULL CHECK (state IN ('approved','hydrating','consumed','rejected')),
 reason_code text,
 approved_at timestamptz NOT NULL DEFAULT now(),
 consumed_at timestamptz
);
ALTER TABLE public.event_invoice_recovery_historical_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_invoice_recovery_historical_evidence FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.event_invoice_recovery_historical_evidence TO service_role;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_historical_fingerprint(
 p_tenant_id uuid,p_source text,p_group text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE fingerprint text;
BEGIN
 IF p_source NOT IN ('booking','complex_event_booking') THEN RAISE EXCEPTION 'Invalid historical source'; END IF;
 -- Mirrors are our own mutations; every other source field is a stale-evidence veto.
 EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(b)-''invoice_recovery_status''-
 ''invoice_recovery_next_attempt_at'' ORDER BY b.id),''[]''::jsonb)::text)
 FROM public.%I b WHERE tenant_id=$1 AND booking_group_reference=$2',p_source)
 INTO fingerprint USING p_tenant_id,p_group;
 RETURN fingerprint;
END $$;

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
 WHERE snapshot IS NULL AND status='needs_review' AND reason_code='snapshot_unavailable'
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

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_historical_valid(s jsonb,e jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE line jsonb; total numeric:=0; amount numeric; digits integer:=2;
BEGIN
 IF s IS NULL OR e IS NULL OR octet_length(s::text)>262144 OR octet_length(e::text)>65536
 OR coalesce(s->>'version','')<>'1' OR coalesce(e->>'version','')<>'1'
 OR coalesce(e->>'kind','') NOT IN ('approved_repair_manifest','original_booking_verified_provider')
 OR coalesce(e->>'environment','')<>'live'
 OR nullif(trim(e->>'approvalReference'),'') IS NULL OR nullif(trim(e->>'approvedBy'),'') IS NULL
 OR nullif(e->>'approvedAt','') IS NULL
 OR jsonb_typeof(e->'provenance') IS DISTINCT FROM 'array'
 OR jsonb_array_length(e->'provenance')=0
 OR nullif(trim(s#>>'{provider,connectionId}'),'') IS NULL
 OR nullif(trim(s#>>'{provider,xeroTenantId}'),'') IS NULL
 OR s#>>'{provider,xeroTenantId}'='PENDING_SELECTION'
 OR coalesce(s->>'paymentMethod','') NOT IN ('stripe','invoice')
 OR coalesce(s->>'currency','') !~ '^[A-Z]{3}$'
 OR coalesce(s#>>'{invoice,Type}','')<>'ACCREC'
 OR (s->'invoice') ?| ARRAY['InvoiceID','InvoiceNumber','Payments']
 OR coalesce(s#>>'{invoice,CurrencyCode}','') IS DISTINCT FROM s->>'currency'
 OR coalesce(s#>>'{invoice,Status}','') NOT IN ('DRAFT','SUBMITTED','AUTHORISED')
 OR (s->>'paymentMethod'='stripe' AND s#>>'{invoice,Status}'<>'AUTHORISED')
 OR coalesce(s#>>'{invoice,LineAmountTypes}','') NOT IN ('Inclusive','Exclusive','NoTax')
 OR coalesce(s#>>'{invoice,Date}','') !~ '^\d{4}-\d{2}-\d{2}$'
 OR coalesce(s#>>'{invoice,DueDate}','') !~ '^\d{4}-\d{2}-\d{2}$'
 OR jsonb_typeof(s->'contact') IS DISTINCT FROM 'object'
 OR coalesce(nullif(s#>>'{invoice,Contact,ContactID}',''),nullif(s#>>'{invoice,Contact,Name}','')) IS NULL
 OR jsonb_typeof(s#>'{invoice,LineItems}') IS DISTINCT FROM 'array'
 OR jsonb_array_length(s#>'{invoice,LineItems}')=0 THEN RETURN false; END IF;
 PERFORM (e->>'approvedAt')::timestamptz;
 PERFORM (s#>>'{invoice,Date}')::date,(s#>>'{invoice,DueDate}')::date;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(e->'provenance') p
   WHERE jsonb_typeof(p) IS DISTINCT FROM 'string' OR trim(p#>>'{}')='') THEN RETURN false; END IF;
 -- ISO zero/three decimal currencies used by checkout; all others default to two.
 IF s->>'currency' IN ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') THEN digits:=0;
 ELSIF s->>'currency' IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN digits:=3; END IF;
 IF jsonb_typeof(s->'amount') IS DISTINCT FROM 'number' OR (s->>'amount')::numeric<=0 THEN RETURN false; END IF;
 FOR line IN SELECT * FROM jsonb_array_elements(s#>'{invoice,LineItems}') LOOP
   IF nullif(trim(line->>'AccountCode'),'') IS NULL OR nullif(trim(line->>'TaxType'),'') IS NULL
   OR jsonb_typeof(line->'UnitAmount') IS DISTINCT FROM 'number'
   OR jsonb_typeof(line->'Quantity') IS DISTINCT FROM 'number'
   OR jsonb_typeof(line->'TaxAmount') IS DISTINCT FROM 'number'
   OR (line->>'Quantity')::numeric<=0
   OR coalesce((line->>'DiscountRate')::numeric,0) NOT BETWEEN 0 AND 100
   OR (s#>>'{invoice,LineAmountTypes}'='NoTax' AND (line->>'TaxAmount')::numeric<>0)
   THEN RETURN false; END IF;
   amount:=round((line->>'UnitAmount')::numeric*(line->>'Quantity')::numeric*
     (1-coalesce((line->>'DiscountRate')::numeric,0)/100),digits);
   IF line ? 'LineAmount' AND (line->>'LineAmount')::numeric IS DISTINCT FROM amount THEN RETURN false; END IF;
   total:=total+amount+CASE WHEN s#>>'{invoice,LineAmountTypes}'='Exclusive' THEN (line->>'TaxAmount')::numeric ELSE 0 END;
 END LOOP;
 IF round(total,digits)<>(s->>'amount')::numeric THEN RETURN false; END IF;
 IF s->>'paymentMethod'='invoice' THEN RETURN s->'settlement' IS NULL OR s->'settlement'='null'; END IF;
 IF s#>'{settlement,livemode}' IS DISTINCT FROM 'true'::jsonb
 OR coalesce(s#>>'{settlement,status}','')<>'succeeded'
 OR coalesce(s#>>'{settlement,paymentIntentId}','') !~ '^pi_[A-Za-z0-9]+$'
 OR s#>>'{settlement,paymentIntentId}' IS DISTINCT FROM e->>'paymentIntentId'
 OR s#>>'{settlement,currency}' IS DISTINCT FROM s->>'currency'
 OR jsonb_typeof(s#>'{settlement,amount}') IS DISTINCT FROM 'number'
 OR (s#>>'{settlement,amount}')::numeric IS DISTINCT FROM (s->>'amount')::numeric
 OR nullif(trim(s#>>'{settlement,accountCode}'),'') IS NULL
 OR nullif(s#>>'{settlement,paidAt}','') IS NULL THEN RETURN false; END IF;
 PERFORM (s#>>'{settlement,paidAt}')::timestamptz;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
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
 IF r.snapshot IS NOT NULL OR r.status<>'needs_review' OR r.reason_code<>'snapshot_unavailable'
 OR r.tenant_id::text IS DISTINCT FROM p_candidate->>'tenantId'
 OR r.source IS DISTINCT FROM p_candidate->>'source'
 OR r.booking_group_reference IS DISTINCT FROM p_candidate->>'bookingGroupReference'
 OR r.updated_at IS DISTINCT FROM (p_candidate->>'operationUpdatedAt')::timestamptz
 OR public.event_invoice_recovery_historical_fingerprint(r.tenant_id,r.source,r.booking_group_reference)
    IS DISTINCT FROM p_candidate->>'bookingFingerprint'
 THEN RAISE EXCEPTION 'Historical candidate stale'; END IF;
 INSERT INTO public.event_invoice_recovery_historical_evidence(operation_id,candidate,snapshot,evidence,state)
 VALUES(r.id,p_candidate,p_snapshot,p_evidence,'approved');
 RETURN jsonb_build_object('status','approved');
END $$;

-- The ONLY immutable-field exception: a persisted approved row in the same
-- transaction, exact snapshot, null original evidence, and unchanged journals.
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF ROW(NEW.tenant_id,NEW.source,NEW.booking_group_reference,NEW.snapshot,NEW.connection_id,NEW.xero_tenant_id,NEW.settlement_payment_intent_id)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.source,OLD.booking_group_reference,OLD.snapshot,OLD.connection_id,OLD.xero_tenant_id,OLD.settlement_payment_intent_id) THEN
   IF OLD.snapshot IS NULL AND OLD.status='needs_review' AND OLD.reason_code='snapshot_unavailable'
   AND NEW.status='pending'
   AND (to_jsonb(NEW)-ARRAY['snapshot','connection_id','xero_tenant_id','settlement_payment_intent_id','status','next_attempt_at','reason_code','updated_at'])
     =(to_jsonb(OLD)-ARRAY['snapshot','connection_id','xero_tenant_id','settlement_payment_intent_id','status','next_attempt_at','reason_code','updated_at'])
   AND (OLD.connection_id IS NULL OR OLD.connection_id=NEW.connection_id)
   AND (OLD.xero_tenant_id IS NULL OR OLD.xero_tenant_id=NEW.xero_tenant_id)
   AND (OLD.settlement_payment_intent_id IS NULL OR OLD.settlement_payment_intent_id=NEW.settlement_payment_intent_id)
   AND EXISTS(SELECT 1 FROM public.event_invoice_recovery_historical_evidence h WHERE h.operation_id=OLD.id
     AND h.state='hydrating' AND h.snapshot=NEW.snapshot
     AND NEW.connection_id=h.snapshot#>>'{provider,connectionId}'
     AND NEW.xero_tenant_id=h.snapshot#>>'{provider,xeroTenantId}'
     AND NEW.settlement_payment_intent_id IS NOT DISTINCT FROM
       CASE WHEN h.snapshot->>'paymentMethod'='stripe' THEN h.snapshot#>>'{settlement,paymentIntentId}' END)
   THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'Recovery identity and snapshot are immutable';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_hydrate_historical(
 p_limit integer DEFAULT 20,p_id uuid DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE h public.event_invoice_recovery_historical_evidence; r public.event_invoice_recovery;
 c public.event_invoice_recovery_connection; safe boolean; n integer:=0; reason text; pi text;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid historical hydration bound'; END IF;
 FOR h IN SELECT * FROM public.event_invoice_recovery_historical_evidence
 WHERE state='approved' AND (p_id IS NULL OR operation_id=p_id)
 ORDER BY approved_at,operation_id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
   reason:=NULL;
   -- Same connection->operation lock order as normal claims. Never reset a
   -- connection embargo/lease or rebind its application/provider ownership.
   INSERT INTO public.event_invoice_recovery_connection(connection_id,tenant_id,xero_tenant_id)
   VALUES(h.snapshot#>>'{provider,connectionId}',(h.candidate->>'tenantId')::uuid,
     h.snapshot#>>'{provider,xeroTenantId}') ON CONFLICT DO NOTHING;
   SELECT * INTO c FROM public.event_invoice_recovery_connection
     WHERE connection_id=h.snapshot#>>'{provider,connectionId}' FOR UPDATE;
   IF c.lease_expires_at>now() THEN CONTINUE; END IF;
   SELECT * INTO r FROM public.event_invoice_recovery WHERE id=h.operation_id FOR UPDATE;
   -- Lock all existing attendees before fingerprint and eligibility checks.
   EXECUTE format('SELECT 1 FROM public.%I WHERE tenant_id=$1 AND booking_group_reference=$2 FOR UPDATE',r.source)
     USING r.tenant_id,r.booking_group_reference;
   pi:=CASE WHEN h.snapshot->>'paymentMethod'='stripe' THEN h.snapshot#>>'{settlement,paymentIntentId}' END;
   IF r.snapshot IS NOT NULL OR r.status<>'needs_review' OR r.reason_code<>'snapshot_unavailable'
   OR r.updated_at IS DISTINCT FROM (h.candidate->>'operationUpdatedAt')::timestamptz
   OR r.lease_token IS NOT NULL OR r.lease_expires_at IS NOT NULL
   OR public.event_invoice_recovery_historical_fingerprint(r.tenant_id,r.source,r.booking_group_reference)
     IS DISTINCT FROM h.candidate->>'bookingFingerprint' THEN reason:='historical_candidate_stale';
   ELSIF NOT public.event_invoice_recovery_historical_valid(h.snapshot,h.evidence) THEN reason:='historical_evidence_invalid';
   ELSIF c.tenant_id<>r.tenant_id OR c.xero_tenant_id<>h.snapshot#>>'{provider,xeroTenantId}'
     OR (r.connection_id IS NOT NULL AND r.connection_id<>c.connection_id)
     OR (r.xero_tenant_id IS NOT NULL AND r.xero_tenant_id<>c.xero_tenant_id)
     THEN reason:='historical_provider_binding_changed';
   ELSIF (r.settlement_payment_intent_id IS NOT NULL AND r.settlement_payment_intent_id IS DISTINCT FROM pi)
     OR EXISTS(SELECT 1 FROM public.event_invoice_recovery q WHERE q.tenant_id=r.tenant_id
       AND q.settlement_payment_intent_id=pi AND q.id<>r.id) THEN reason:='settlement_already_owned';
   END IF;
   EXECUTE format('SELECT count(*)>0 AND bool_and(coalesce(
     public.event_invoice_recovery_eligible(to_jsonb(b))
     AND coalesce(to_jsonb(b)->>''payment_status'','''') NOT IN (''refunded'',''failed'',''cancelled'')
     AND (($3=''stripe'' AND payment_method IN (''card'',''stripe'',''mixed''))
       OR ($3=''invoice'' AND payment_method IN (''invoice'',''account'')))
     AND ($4 IS NULL OR nullif(to_jsonb(b)->>''stripe_payment_intent_id'','''') IS NULL
       OR to_jsonb(b)->>''stripe_payment_intent_id''=$4),false))
     AND ($4 IS NULL OR bool_or(to_jsonb(b)->>''stripe_payment_intent_id''=$4))
     FROM public.%I b WHERE tenant_id=$1 AND booking_group_reference=$2',r.source)
   INTO safe USING r.tenant_id,r.booking_group_reference,h.snapshot->>'paymentMethod',pi;
   IF NOT coalesce(safe,false) THEN reason:=coalesce(reason,'historical_booking_ineligible'); END IF;
   IF reason IS NOT NULL THEN
     UPDATE public.event_invoice_recovery_historical_evidence SET state='rejected',reason_code=reason WHERE operation_id=h.operation_id;
     CONTINUE;
   END IF;
   BEGIN
     UPDATE public.event_invoice_recovery_historical_evidence SET state='hydrating' WHERE operation_id=h.operation_id;
     UPDATE public.event_invoice_recovery SET snapshot=h.snapshot,connection_id=c.connection_id,xero_tenant_id=c.xero_tenant_id,
       settlement_payment_intent_id=pi,status='pending',next_attempt_at=greatest(now(),c.cooldown_until),
       reason_code=NULL,updated_at=now() WHERE id=r.id;
     UPDATE public.event_invoice_recovery_historical_evidence SET state='consumed',consumed_at=now() WHERE operation_id=h.operation_id;
     n:=n+1;
   EXCEPTION WHEN unique_violation THEN
     UPDATE public.event_invoice_recovery_historical_evidence SET state='rejected',reason_code='settlement_already_owned' WHERE operation_id=h.operation_id;
   END;
 END LOOP;
 RETURN n;
END $$;

DO $$
DECLARE f record;
BEGIN
 FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc
 WHERE pronamespace='public'::regnamespace AND proname LIKE 'event_invoice_recovery_%' LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
COMMIT;