BEGIN;
CREATE TABLE public.public_invoice_po_billing (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('booking','complex_event_booking')),
 booking_group_reference text NOT NULL,
 event_id uuid NOT NULL,
 member_id uuid NOT NULL,
 actor_id text NOT NULL,
 original_records jsonb NOT NULL,
 amount numeric(14,2) NOT NULL CHECK(amount>0),
 currency text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('xero','quickbooks')),
 provider_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 invoice_id text,
 invoice_number text,
 invoice_date date,
 invoice_status text NOT NULL DEFAULT 'pending',
 payment_status text NOT NULL DEFAULT 'unpaid',
 amount_due numeric(14,2),
 checked_at timestamptz,
 check_error text,
 UNIQUE(tenant_id,source,booking_group_reference)
);
ALTER TABLE public.public_invoice_po_billing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.public_invoice_po_billing FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.public_invoice_po_billing TO service_role;
GRANT UPDATE(invoice_id,invoice_number,invoice_date,invoice_status,payment_status,amount_due,checked_at,check_error)
 ON public.public_invoice_po_billing TO service_role;
ALTER TABLE public.booking ADD COLUMN public_invoice_po_billing_id uuid REFERENCES public.public_invoice_po_billing(id);
ALTER TABLE public.complex_event_booking ADD COLUMN public_invoice_po_billing_id uuid REFERENCES public.public_invoice_po_billing(id);
CREATE INDEX public_invoice_po_billing_member ON public.public_invoice_po_billing(tenant_id,member_id,created_at);

-- Explicit admin conversion only. Historic purchaser evidence remains intact.
-- Conversion and durable provider capture commit together or neither commits.
CREATE FUNCTION public.public_invoice_po_bill(
 p_tenant uuid,p_source text,p_group text,p_member uuid,p_actor text,
 p_original jsonb,p_amount numeric,p_currency text,p_provider text,p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rows_now jsonb; r public_invoice_po_billing; b jsonb; purchaser_email text; result jsonb;
BEGIN
 IF p_tenant IS NULL OR p_source NOT IN ('booking','complex_event_booking') OR nullif(p_group,'') IS NULL
   OR p_member IS NULL OR nullif(p_actor,'') IS NULL OR p_amount IS NULL OR p_amount<=0
   OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' OR p_provider NOT IN ('xero','quickbooks')
   OR p_snapshot IS NULL OR p_original IS NULL OR jsonb_typeof(p_original)<>'array'
   THEN RAISE EXCEPTION 'Invalid invoice approval'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':public-po:'||p_source||':'||p_group,0));
 SELECT * INTO r FROM public_invoice_po_billing WHERE tenant_id=p_tenant AND source=p_source AND booking_group_reference=p_group;
 IF FOUND THEN RETURN jsonb_build_object('id',r.id,'status',r.invoice_status,'queued',true); END IF;
 EXECUTE format('SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM
   (SELECT * FROM public.%I WHERE tenant_id=$1 AND booking_group_reference=$2 ORDER BY id FOR UPDATE) b',p_source)
 INTO rows_now USING p_tenant,p_group;
 IF rows_now IS NULL OR rows_now<>p_original THEN RAISE EXCEPTION 'Booking changed; review the invoice again'; END IF;
 IF (SELECT round(sum((value->>(CASE WHEN p_source='booking' THEN 'total_cost' ELSE 'ticket_price' END))::numeric
   - CASE WHEN p_source='booking' THEN coalesce((value->>'discount_code_amount')::numeric,0) ELSE 0 END),2)
   FROM jsonb_array_elements(rows_now)) IS DISTINCT FROM p_amount
 THEN RAISE EXCEPTION 'Invoice total does not match the recorded booking'; END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(rows_now) LOOP
   IF b->>'payment_method' IS DISTINCT FROM 'public_invoice_po'
      OR b->>'status' IS DISTINCT FROM 'confirmed'
      OR b#>>'{purchaser_context,classification}' IS DISTINCT FROM 'public_non_member'
      OR nullif(b->>'xero_invoice_id','') IS NOT NULL OR nullif(b->>'accounting_invoice_id','') IS NOT NULL
      OR nullif(b->>'stripe_payment_intent_id','') IS NOT NULL
      OR nullif(b->>'public_invoice_po_billing_id','') IS NOT NULL THEN RAISE EXCEPTION 'Booking is not an uninvoiced public PO intention'; END IF;
   IF upper(coalesce(nullif(b->>'currency',''),'GBP'))<>p_currency
      OR nullif(b->>(CASE WHEN p_source='booking' THEN 'total_cost' ELSE 'ticket_price' END),'') IS NULL
   THEN RAISE EXCEPTION 'Booking amount or currency requires review'; END IF;
   IF b->>'event_id' IS DISTINCT FROM rows_now#>>'{0,event_id}'
      OR b->'purchaser_context' IS DISTINCT FROM rows_now#>'{0,purchaser_context}'
   THEN RAISE EXCEPTION 'Booking group has inconsistent purchaser evidence'; END IF;
 END LOOP;
 purchaser_email:=lower(trim(rows_now#>>'{0,purchaser_context,details,email}'));
 PERFORM 1 FROM member WHERE id=p_member AND tenant_id=p_tenant AND lower(trim(email))=purchaser_email FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invoice member must be the original booker'; END IF;
 IF p_provider='xero' AND (p_snapshot->>'paymentMethod' IS DISTINCT FROM 'invoice'
   OR p_snapshot->'settlement' IS DISTINCT FROM 'null'::jsonb
   OR (p_snapshot->>'amount')::numeric IS DISTINCT FROM p_amount
   OR p_snapshot->>'currency' IS DISTINCT FROM p_currency
   OR p_snapshot#>>'{contact,provenance,id}' IS DISTINCT FROM p_member::text) THEN RAISE EXCEPTION 'Invalid unpaid invoice snapshot'; END IF;
 IF p_provider='quickbooks' AND (p_snapshot#>>'{invoice,paymentMethod}' IS DISTINCT FROM 'invoice'
   OR p_snapshot->'payment' IS DISTINCT FROM 'null'::jsonb
   OR (p_snapshot#>>'{invoice,amount}')::numeric IS DISTINCT FROM p_amount
   OR p_snapshot#>>'{invoice,currency}' IS DISTINCT FROM p_currency
   OR p_snapshot#>>'{invoice,contact,provenance,id}' IS DISTINCT FROM p_member::text) THEN RAISE EXCEPTION 'Invalid unpaid invoice snapshot'; END IF;
 INSERT INTO public_invoice_po_billing(tenant_id,source,booking_group_reference,event_id,member_id,actor_id,
   original_records,amount,currency,provider,provider_snapshot,amount_due)
 VALUES(p_tenant,p_source,p_group,(rows_now#>>'{0,event_id}')::uuid,p_member,p_actor,
   rows_now,p_amount,p_currency,p_provider,p_snapshot,p_amount) RETURNING * INTO r;
 EXECUTE format('UPDATE public.%I SET payment_method=''invoice'',public_invoice_po_billing_id=$1,
   purchaser_context=jsonb_set(purchaser_context,''{invoice_approval_id}'',to_jsonb($1))
   WHERE tenant_id=$2 AND booking_group_reference=$3',p_source) USING r.id,p_tenant,p_group;
 IF p_provider='xero' THEN
   SELECT to_jsonb(x) INTO result FROM public.event_invoice_recovery_enqueue(p_tenant,p_source,p_group,p_snapshot,true) x;
   IF result->>'status' NOT IN ('pending','processing','retry','complete') THEN RAISE EXCEPTION 'Invoice queue rejected approval'; END IF;
 ELSE
   SELECT to_jsonb(x) INTO result FROM public.accounting_event_capture(p_tenant,p_source,p_group,
     p_snapshot#>>'{approvalProvider,connectionId}',p_snapshot#>>'{approvalProvider,realmId}',
     p_snapshot-'approvalProvider') x;
 END IF;
 RETURN jsonb_build_object('id',r.id,'status','pending','queued',true);
END $$;
REVOKE ALL ON FUNCTION public.public_invoice_po_bill(uuid,text,text,uuid,text,jsonb,numeric,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.public_invoice_po_bill(uuid,text,text,uuid,text,jsonb,numeric,text,text,jsonb) TO service_role;

-- QBO's ordinary path intentionally accepts only fresh checkouts. An explicit
-- approval above is fresh invoicing authority, not a fabricated booking date.
DO $patch$
DECLARE d text; old text; replacement text;
BEGIN
 d:=pg_get_functiondef('public.accounting_event_capture(uuid,text,text,text,text,jsonb)'::regprocedure);
 old:='OR coalesce((j->>''created_at'')::timestamptz,''-infinity'')<now()-interval ''1 hour''';
 -- The comparison is inside a dynamically quoted SQL string.
 old:=replace(old,'''','''''');
 -- Use an exact replacement with no additional dynamic USING parameters.
 replacement:='OR (coalesce((j->>''''created_at'''')::timestamptz,''''-infinity'''')<now()-interval ''''1 hour''''
   AND NOT EXISTS(SELECT 1 FROM public.public_invoice_po_billing a WHERE a.id=nullif(j->>''''public_invoice_po_billing_id'''','''''''')::uuid
     AND a.tenant_id=$1 AND a.booking_group_reference=$2 AND a.created_at>=now()-interval ''''5 minutes''''))';
 IF position(old in d)=0 THEN RAISE EXCEPTION 'QBO capture contract changed; migration requires review'; END IF;
 EXECUTE replace(d,old,replacement);
END $patch$;
NOTIFY pgrst,'reload schema';
COMMIT;
