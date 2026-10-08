-- Future QuickBooks event checkouts only. No historical financial replay.
BEGIN;
ALTER TABLE public.booking ADD COLUMN IF NOT EXISTS accounting_provider text,
  ADD COLUMN IF NOT EXISTS accounting_invoice_id text,
  ADD COLUMN IF NOT EXISTS accounting_invoice_number text;
ALTER TABLE public.complex_event_booking ADD COLUMN IF NOT EXISTS accounting_provider text,
  ADD COLUMN IF NOT EXISTS accounting_invoice_id text,
  ADD COLUMN IF NOT EXISTS accounting_invoice_number text;

CREATE TABLE IF NOT EXISTS public.accounting_event_operation (
  tenant_id uuid NOT NULL,
  source text NOT NULL CHECK(source IN ('booking','complex_event_booking')),
  booking_group_reference text NOT NULL,
  connection_id text NOT NULL,
  company_id text NOT NULL,
  snapshot jsonb NOT NULL,
  booking_evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,source,booking_group_reference)
);
ALTER TABLE public.accounting_event_operation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_event_operation FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_event_operation TO service_role;

CREATE OR REPLACE FUNCTION public.accounting_event_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'Event accounting authority is immutable'; END $$;
DROP TRIGGER IF EXISTS accounting_event_immutable ON public.accounting_event_operation;
CREATE TRIGGER accounting_event_immutable BEFORE UPDATE OR DELETE ON public.accounting_event_operation
FOR EACH ROW EXECUTE FUNCTION public.accounting_event_immutable();

-- Compare only original purchaser/financial/eligibility fields. Survey revisions,
-- invoice mirrors, attendee reminders and other operational edits are unrelated.
CREATE OR REPLACE FUNCTION public.accounting_event_evidence(p_tenant uuid,p_source text,p_group text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb;
BEGIN
 IF p_tenant IS NULL OR p_source IS NULL OR p_source NOT IN ('booking','complex_event_booking')
   OR nullif(p_group,'') IS NULL THEN RAISE EXCEPTION 'Invalid event scope'; END IF;
 EXECUTE format('SELECT jsonb_agg(jsonb_build_object(
   ''id'',b.id,''tenant_id'',b.tenant_id,''event_id'',j->''event_id'',
   ''complex_event_id'',j->''complex_event_id'',
   ''status'',j->''status'',''payment_method'',j->''payment_method'',''payment_status'',j->''payment_status'',
   ''stripe_payment_intent_id'',j->''stripe_payment_intent_id'',
   ''member_id'',j->''member_id'',''organization_id'',j->''organization_id'',
   ''attendee_email'',j->''attendee_email'',''ticket_price'',j->''ticket_price'',
   ''total_amount'',j->''total_amount'',''total_paid'',j->''total_paid'',
   ''ticket_class_id'',j->''ticket_class_id'',''ticket_id'',j->''ticket_id'',
   ''voucher_amount'',j->''voucher_amount'',''training_fund_amount'',j->''training_fund_amount''
 ) ORDER BY b.id) FROM public.%I b CROSS JOIN LATERAL (SELECT to_jsonb(b) AS j) s
 WHERE b.tenant_id=$1 AND b.booking_group_reference=$2',p_source)
 INTO result USING p_tenant,p_group;
 RETURN result;
END $$;

-- One Stripe receipt cannot acquire both an old Xero event owner and a new QBO
-- owner. Xact advisory locking serializes claims across both authority tables.
CREATE TABLE IF NOT EXISTS public.accounting_event_settlement_owner (
 tenant_id uuid NOT NULL, payment_intent_id text NOT NULL,
 source text NOT NULL, booking_group_reference text NOT NULL,
 PRIMARY KEY(tenant_id,payment_intent_id)
);
ALTER TABLE public.accounting_event_settlement_owner ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_event_settlement_owner FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.accounting_event_claim_settlement(
 p_tenant uuid,p_pi text,p_source text,p_group text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE owner public.accounting_event_settlement_owner;
BEGIN
 IF p_pi IS NULL THEN RETURN; END IF;
 IF p_tenant IS NULL OR p_pi !~ '^pi_[A-Za-z0-9]+$'
 OR p_source IS NULL OR p_source NOT IN ('booking','complex_event_booking')
 OR nullif(p_group,'') IS NULL THEN RAISE EXCEPTION 'Invalid event settlement'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||p_pi,0));
 IF EXISTS(SELECT 1 FROM public.event_invoice_recovery r WHERE r.tenant_id=p_tenant
   AND r.settlement_payment_intent_id=p_pi
   AND (r.source<>p_source OR r.booking_group_reference<>p_group))
 THEN RAISE EXCEPTION 'Event settlement already owned'; END IF;
 INSERT INTO public.accounting_event_settlement_owner VALUES(p_tenant,p_pi,p_source,p_group)
 ON CONFLICT DO NOTHING;
 SELECT * INTO owner FROM public.accounting_event_settlement_owner
 WHERE tenant_id=p_tenant AND payment_intent_id=p_pi;
 IF owner.source<>p_source OR owner.booking_group_reference<>p_group THEN
   RAISE EXCEPTION 'Event settlement already owned';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.accounting_event_xero_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.source||':'||NEW.booking_group_reference,1));
 IF EXISTS(SELECT 1 FROM public.accounting_event_operation o WHERE o.tenant_id=NEW.tenant_id
 AND o.source=NEW.source AND o.booking_group_reference=NEW.booking_group_reference) THEN
 RAISE EXCEPTION 'QuickBooks already owns event accounting'; END IF;
 PERFORM public.accounting_event_claim_settlement(NEW.tenant_id,NEW.settlement_payment_intent_id,NEW.source,NEW.booking_group_reference);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS accounting_event_xero_owner ON public.event_invoice_recovery;
CREATE TRIGGER accounting_event_xero_owner BEFORE INSERT OR UPDATE OF settlement_payment_intent_id
 ON public.event_invoice_recovery FOR EACH ROW EXECUTE FUNCTION public.accounting_event_xero_owner();

CREATE OR REPLACE FUNCTION public.accounting_event_capture(
 p_tenant uuid,p_source text,p_group text,p_connection text,p_company text,p_snapshot jsonb
) RETURNS public.accounting_request_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o public.accounting_event_operation; q public.accounting_request_queue; evidence jsonb; invalid boolean;
BEGIN
 IF p_tenant IS NULL OR p_source IS NULL OR p_source NOT IN ('booking','complex_event_booking')
 OR nullif(p_group,'') IS NULL OR length(p_group)>200 THEN RAISE EXCEPTION 'Invalid event scope'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||p_source||':'||p_group,1));
 -- Ownership wins over current settings and any reconstructed caller payload.
 SELECT * INTO q FROM public.accounting_request_queue WHERE tenant_id=p_tenant AND source_type=p_source AND source_id=p_group;
 IF FOUND THEN RETURN q; END IF;
 IF EXISTS(SELECT 1 FROM public.event_invoice_recovery WHERE tenant_id=p_tenant AND source=p_source AND booking_group_reference=p_group)
 THEN RAISE EXCEPTION 'Existing event recovery owner'; END IF;
 IF p_snapshot IS NULL OR p_snapshot->>'version' IS DISTINCT FROM '1'
 OR p_snapshot->>'preparation' IS DISTINCT FROM 'true'
 OR p_snapshot#>>'{linkage,source}' IS DISTINCT FROM p_source
 OR p_snapshot#>>'{linkage,group}' IS DISTINCT FROM p_group
 OR coalesce(p_snapshot#>>'{invoice,paymentMethod}','') NOT IN ('stripe','invoice')
 OR coalesce((p_snapshot#>>'{invoice,capturedAt}')::timestamptz,'-infinity') NOT BETWEEN now()-interval '15 minutes' AND now()+interval '1 minute'
 OR octet_length(p_snapshot::text)>262144
 THEN RAISE EXCEPTION 'Invalid future event authority'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tenant_accounting_settings WHERE tenant_id=p_tenant AND active_provider='quickbooks')
 OR NOT EXISTS(SELECT 1 FROM public.quickbooks_token WHERE app_tenant_id=p_tenant AND id::text=p_connection
   AND realm_id=p_company AND environment=p_snapshot->>'environment')
 THEN RAISE EXCEPTION 'QuickBooks binding changed'; END IF;
 -- Lock all attendees before capturing; linkage later uses the same row locks.
 EXECUTE format('SELECT bool_or(
   coalesce(j->>''status'','''') IN (''cancelled'',''canceled'',''refunded'',''failed'',''pending_payment'')
   OR coalesce(j->>''payment_method'','''') NOT IN (''account'',''invoice'',''card'',''stripe'',''mixed'')
   OR nullif(j->>''xero_invoice_id'','''') IS NOT NULL OR nullif(j->>''accounting_invoice_id'','''') IS NOT NULL
   OR coalesce((j->>''created_at'')::timestamptz,''-infinity'')<now()-interval ''1 hour''
   OR coalesce(j->>''event_id'',j->>''complex_event_id'','''')<>$3)
   FROM (SELECT to_jsonb(b) AS j FROM public.%I b WHERE tenant_id=$1 AND booking_group_reference=$2 FOR UPDATE) s',p_source)
 INTO invalid USING p_tenant,p_group,p_snapshot#>>'{invoice,eventId}';
 evidence:=public.accounting_event_evidence(p_tenant,p_source,p_group);
 IF evidence IS NULL OR invalid IS DISTINCT FROM false THEN RAISE EXCEPTION 'Event not eligible for future capture'; END IF;
 IF p_snapshot#>>'{invoice,paymentMethod}'='stripe' AND p_snapshot#>>'{payment,paymentIntentId}' IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(evidence) e WHERE e->>'stripe_payment_intent_id'=p_snapshot#>>'{payment,paymentIntentId}')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(evidence) e WHERE nullif(e->>'stripe_payment_intent_id','') IS NOT NULL
     AND e->>'stripe_payment_intent_id'<>p_snapshot#>>'{payment,paymentIntentId}')
   THEN RAISE EXCEPTION 'Original event payment mismatch'; END IF;
   PERFORM public.accounting_event_claim_settlement(p_tenant,p_snapshot#>>'{payment,paymentIntentId}',p_source,p_group);
 END IF;
 INSERT INTO public.accounting_event_operation VALUES(p_tenant,p_source,p_group,p_connection,p_company,p_snapshot,evidence,now());
 SELECT * INTO q FROM public.accounting_request_enqueue(
   p_tenant,'quickbooks',p_connection,p_company,p_source,p_group,'invoice',p_snapshot);
 RETURN q;
END $$;

CREATE OR REPLACE FUNCTION public.accounting_event_guard(p_id uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q public.accounting_request_queue; o public.accounting_event_operation; conflict boolean;
BEGIN
 SELECT * INTO q FROM public.accounting_request_queue WHERE id=p_id AND lease_token=p_token
 AND state='running' AND lease_until>now();
 IF NOT FOUND OR q.source_type NOT IN ('booking','complex_event_booking') OR q.provider<>'quickbooks' THEN RETURN false; END IF;
 SELECT * INTO o FROM public.accounting_event_operation WHERE tenant_id=q.tenant_id
 AND source=q.source_type AND booking_group_reference=q.source_id;
 IF NOT FOUND OR o.connection_id<>q.connection_id OR o.company_id<>q.company_id OR o.snapshot<>q.snapshot
 OR o.booking_evidence IS DISTINCT FROM public.accounting_event_evidence(q.tenant_id,q.source_type,q.source_id) THEN RETURN false; END IF;
 EXECUTE format('SELECT bool_or(nullif(xero_invoice_id,'''') IS NOT NULL
 OR (nullif(accounting_invoice_id,'''') IS NOT NULL AND
   (accounting_invoice_id IS DISTINCT FROM $3 OR accounting_provider IS DISTINCT FROM ''quickbooks'')))
 FROM public.%I WHERE tenant_id=$1 AND booking_group_reference=$2',q.source_type)
 INTO conflict USING q.tenant_id,q.source_id,q.invoice_result->>'id';
 RETURN conflict IS false;
END $$;

CREATE OR REPLACE FUNCTION public.accounting_event_link(p_id uuid,p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q public.accounting_request_queue;
BEGIN
 SELECT * INTO q FROM public.accounting_request_queue WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR q.source_type NOT IN ('booking','complex_event_booking') THEN RAISE EXCEPTION 'Invalid event request'; END IF;
 EXECUTE format('SELECT 1 FROM public.%I WHERE tenant_id=$1 AND booking_group_reference=$2 FOR UPDATE',q.source_type)
 USING q.tenant_id,q.source_id;
 IF NOT public.accounting_event_guard(p_id,p_token) OR q.invoice_status<>'done'
 OR q.payment_status NOT IN ('done','skipped') OR nullif(q.invoice_result->>'id','') IS NULL
 THEN RAISE EXCEPTION 'Event link authority unavailable'; END IF;
 EXECUTE format('UPDATE public.%I SET accounting_provider=''quickbooks'',accounting_invoice_id=$3,
 accounting_invoice_number=$4 WHERE tenant_id=$1 AND booking_group_reference=$2
 AND accounting_invoice_id IS NULL',q.source_type)
 USING q.tenant_id,q.source_id,q.invoice_result->>'id',
 coalesce(q.invoice_result->>'invoiceNumber',q.invoice_result->>'invoice_number');
 RETURN jsonb_build_object('linked',true);
END $$;

CREATE OR REPLACE FUNCTION public.accounting_event_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE status text;
BEGIN
 IF NEW.source_type NOT IN ('booking','complex_event_booking') THEN RETURN NEW; END IF;
 status:=CASE NEW.state WHEN 'complete' THEN 'complete' WHEN 'review' THEN 'needs_review'
 WHEN 'running' THEN 'processing' WHEN 'pending' THEN 'pending' ELSE 'retry' END;
 EXECUTE format('UPDATE public.%I SET invoice_recovery_status=$3,invoice_recovery_next_attempt_at=$4
 WHERE tenant_id=$1 AND booking_group_reference=$2
 AND (invoice_recovery_status IS DISTINCT FROM $3 OR invoice_recovery_next_attempt_at IS DISTINCT FROM $4)',NEW.source_type)
 USING NEW.tenant_id,NEW.source_id,status,CASE WHEN status IN ('pending','retry','processing') THEN NEW.next_attempt_at END;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS accounting_event_mirror ON public.accounting_request_queue;
CREATE TRIGGER accounting_event_mirror AFTER INSERT OR UPDATE OF state,next_attempt_at ON public.accounting_request_queue
FOR EACH ROW EXECUTE FUNCTION public.accounting_event_mirror();

CREATE OR REPLACE FUNCTION public.accounting_event_due() RETURNS uuid[]
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT coalesce(array_agg(id),'{}'::uuid[]) FROM (
 SELECT q.id FROM public.accounting_request_queue q
 JOIN public.accounting_request_binding b ON b.provider=q.provider AND b.company_id=q.company_id
 WHERE q.source_type IN ('booking','complex_event_booking') AND q.provider='quickbooks'
 AND q.state IN ('pending','retry','unknown','running') AND q.next_attempt_at<=now()
 AND coalesce(q.lease_until,'-infinity')<=now() AND b.cooldown_until<=now()
 AND coalesce(b.lease_until,'-infinity')<=now()
 ORDER BY q.next_attempt_at,q.id LIMIT 8) due
$$;

REVOKE ALL ON FUNCTION public.accounting_event_immutable(),public.accounting_event_xero_owner(),
 public.accounting_event_mirror(),public.accounting_event_evidence(uuid,text,text),
 public.accounting_event_claim_settlement(uuid,text,text,text),
 public.accounting_event_capture(uuid,text,text,text,text,jsonb),
 public.accounting_event_guard(uuid,uuid),public.accounting_event_link(uuid,uuid),public.accounting_event_due()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.accounting_event_capture(uuid,text,text,text,text,jsonb),
 public.accounting_event_guard(uuid,uuid),public.accounting_event_link(uuid,uuid),public.accounting_event_due() TO service_role;
COMMIT;
