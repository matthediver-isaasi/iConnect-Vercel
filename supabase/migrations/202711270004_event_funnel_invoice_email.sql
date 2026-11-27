-- Event funnel invoice email: once every applicable invoice for an order is
-- issued, ONE email carrying all invoice PDFs is sent to the order's invoice
-- contact (falling back to the booker). One journal row per order; a send
-- with an unknown outcome is never repeated automatically.
BEGIN;
CREATE TABLE public.event_funnel_invoice_email(
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  recipient text NOT NULL,
  invoice_work_ids uuid[] NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','writing','delivered','needs_review')),
  payload jsonb,
  attempt_token uuid,
  message_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  PRIMARY KEY(tenant_id,order_id),
  FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
ALTER TABLE public.event_funnel_invoice_email ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_invoice_email FROM PUBLIC,anon,authenticated,service_role;

-- The address frozen in the order snapshot at submission; never a live lookup.
CREATE FUNCTION public.event_funnel_invoice_email_recipient(p_snapshot jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT candidate FROM (VALUES
    (1,lower(nullif(trim(p_snapshot#>>'{invoiceCustomer,email}'),''))),
    (2,lower(nullif(trim(p_snapshot#>>'{purchaser,email}'),'')))) c(rank,candidate)
  WHERE candidate IS NOT NULL AND length(candidate)<=320
    AND candidate ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ORDER BY rank LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.event_funnel_invoice_email_recipient(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Service-only journal, fenced by the live 'invoices' delivery lease.
--   read   -> {status, recipient, invoices[], events[]}
--             status: complete | waiting | pending | needs_review
--   begin  -> {status:'send', payload} exactly once per pending attempt
--   finish -> records accepted | not_submitted | unknown
CREATE FUNCTION public.event_funnel_invoice_email_operation(
  p_tenant uuid,p_order uuid,p_token uuid,p_action text,p_payload jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order;m public.event_funnel_invoice_email;recipient text;
  work_ids uuid[];invoices jsonb;events jsonb;
BEGIN
  PERFORM 1 FROM public.event_funnel_delivery WHERE tenant_id=p_tenant AND order_id=p_order AND kind='invoices'
    AND p_token IS NOT NULL AND lease_token=p_token AND lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice email lease unavailable' USING ERRCODE='PT409';END IF;
  SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order;
  IF NOT FOUND OR o.state<>'confirmed' THEN RAISE EXCEPTION 'Order not confirmed' USING ERRCODE='PT409';END IF;
  SELECT * INTO m FROM public.event_funnel_invoice_email WHERE tenant_id=p_tenant AND order_id=p_order FOR UPDATE;

  IF p_action='read' THEN
    IF NOT FOUND THEN
      IF o.payable_minor=0 THEN RETURN jsonb_build_object('status','complete');END IF;
      IF EXISTS(SELECT 1 FROM public.event_funnel_invoice_work WHERE tenant_id=p_tenant AND order_id=p_order
        AND status NOT IN ('complete','not_applicable')) OR NOT EXISTS(SELECT 1 FROM public.event_funnel_invoice_work
        WHERE tenant_id=p_tenant AND order_id=p_order) THEN
        RETURN jsonb_build_object('status','waiting');
      END IF;
      SELECT array_agg(id ORDER BY allocation_key) INTO work_ids FROM public.event_funnel_invoice_work
        WHERE tenant_id=p_tenant AND order_id=p_order AND status='complete' AND invoice_id IS NOT NULL;
      recipient:=public.event_funnel_invoice_email_recipient(o.snapshot);
      IF work_ids IS NULL OR recipient IS NULL THEN RETURN jsonb_build_object('status','complete');END IF;
      INSERT INTO public.event_funnel_invoice_email(tenant_id,order_id,recipient,invoice_work_ids)
        VALUES(p_tenant,p_order,recipient,work_ids) RETURNING * INTO m;
    END IF;
    IF m.state='delivered' THEN RETURN jsonb_build_object('status','complete');END IF;
    IF m.state<>'pending' THEN RETURN jsonb_build_object('status','needs_review');END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'invoiceId',w.invoice_id,'invoiceNumber',w.invoice_number,
        'provider',w.provider,
        'companyId',CASE WHEN w.provider='xero' THEN w.xero_tenant_id ELSE w.snapshot#>>'{approvalProvider,realmId}' END,
        'connectionId',CASE WHEN w.provider='xero' THEN w.connection_id ELSE w.snapshot#>>'{approvalProvider,connectionId}' END,
        'environment',w.snapshot->>'environment') ORDER BY w.allocation_key),'[]'::jsonb) INTO invoices
      FROM public.event_funnel_invoice_work w WHERE w.tenant_id=p_tenant AND w.order_id=p_order
        AND w.id=ANY(m.invoice_work_ids) AND w.status='complete' AND w.invoice_id IS NOT NULL;
    IF jsonb_array_length(invoices)<>cardinality(m.invoice_work_ids) THEN
      RAISE EXCEPTION 'Issued invoice evidence changed' USING ERRCODE='PT409';
    END IF;
    SELECT coalesce(jsonb_agg(DISTINCT title),'[]'::jsonb) INTO events FROM (
      SELECT nullif(trim(line#>>'{priceSnapshot,eventTitle}'),'') title
        FROM jsonb_array_elements(coalesce(o.snapshot->'lines','[]'::jsonb)) line) t WHERE title IS NOT NULL;
    RETURN jsonb_build_object('status','pending','recipient',m.recipient,'invoices',invoices,'events',events,
      'currency',o.currency,'payableMinor',o.payable_minor);
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice email unavailable' USING ERRCODE='PT404';END IF;
  IF p_action='begin' THEN
    IF m.state='delivered' THEN RETURN jsonb_build_object('status','complete');END IF;
    IF m.state<>'pending' THEN RETURN jsonb_build_object('status','needs_review');END IF;
    IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text)>200000
      OR p_payload->>'to' IS DISTINCT FROM m.recipient
      OR nullif(p_payload->>'subject','') IS NULL OR nullif(p_payload->>'html','') IS NULL
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('to','subject','html'))
      THEN RAISE EXCEPTION 'Invalid invoice email envelope';END IF;
    -- A not-submitted retry resends the original envelope unchanged.
    UPDATE public.event_funnel_invoice_email SET payload=coalesce(payload,p_payload),state='writing',attempt_token=p_token
      WHERE tenant_id=p_tenant AND order_id=p_order RETURNING * INTO m;
    RETURN jsonb_build_object('status','send','payload',m.payload);
  ELSIF p_action='finish' THEN
    IF m.state='delivered' THEN RETURN jsonb_build_object('status','complete');END IF;
    IF m.state<>'writing' OR m.attempt_token IS DISTINCT FROM p_token THEN
      RAISE EXCEPTION 'Invoice email attempt changed' USING ERRCODE='PT409';END IF;
    IF p_payload->>'outcome' IS NULL OR p_payload->>'outcome' NOT IN ('accepted','not_submitted','unknown')
      THEN RAISE EXCEPTION 'Invalid invoice email outcome';END IF;
    UPDATE public.event_funnel_invoice_email SET state=CASE p_payload->>'outcome'
        WHEN 'accepted' THEN 'delivered' WHEN 'not_submitted' THEN 'pending' ELSE 'needs_review' END,
      attempt_token=NULL,message_id=left(p_payload->>'messageId',500),
      delivered_at=CASE WHEN p_payload->>'outcome'='accepted' THEN clock_timestamp() END
      WHERE tenant_id=p_tenant AND order_id=p_order RETURNING * INTO m;
    RETURN jsonb_build_object('status',CASE m.state WHEN 'delivered' THEN 'complete' WHEN 'pending' THEN 'pending' ELSE 'needs_review' END);
  END IF;
  RAISE EXCEPTION 'Unknown invoice email operation';
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_invoice_email_operation(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_invoice_email_operation(uuid,uuid,uuid,text,jsonb) TO service_role;

-- Owner view: the same list as before plus where the invoices are emailed.
CREATE OR REPLACE FUNCTION public.event_funnel_owned_invoices(
  p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text,p_order uuid,p_invoice uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o jsonb;w public.event_funnel_invoice_work;items jsonb;m public.event_funnel_invoice_email;recipient text;
BEGIN
  o:=public.event_funnel_owned_order(p_tenant,p_id,p_member,p_capability_hash,p_order);
  IF o->>'state' IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'Booking is not confirmed' USING ERRCODE='PT409';
  END IF;
  IF p_invoice IS NOT NULL THEN
    SELECT * INTO w FROM public.event_funnel_invoice_work WHERE id=p_invoice
      AND tenant_id=p_tenant AND order_id=p_order AND status='complete' AND invoice_id IS NOT NULL;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.event_funnel_invoice_booking l
      JOIN public.event_funnel_order_booking b USING(tenant_id,booking_source,booking_id)
      WHERE l.invoice_work_id=w.id AND b.tenant_id=p_tenant AND b.order_id=p_order) THEN
      RAISE EXCEPTION 'Invoice not available' USING ERRCODE='PT404';
    END IF;
    RETURN jsonb_build_object('invoiceId',w.invoice_id,'invoiceNumber',w.invoice_number,'provider',w.provider,
      'companyId',CASE WHEN w.provider='xero' THEN w.xero_tenant_id ELSE w.snapshot#>>'{approvalProvider,realmId}' END,
      'connectionId',CASE WHEN w.provider='xero' THEN w.connection_id ELSE w.snapshot#>>'{approvalProvider,connectionId}' END,
      'environment',w.snapshot->>'environment');
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',j.id,'number',j.invoice_number,
    'status',j.status,'available',j.status='complete' AND j.invoice_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM public.event_funnel_invoice_booking l WHERE l.tenant_id=p_tenant AND l.invoice_work_id=j.id))
    ORDER BY j.allocation_key),'[]'::jsonb) INTO items
    FROM public.event_funnel_invoice_work j WHERE j.tenant_id=p_tenant AND j.order_id=p_order
      AND j.status<>'not_applicable';
  SELECT * INTO m FROM public.event_funnel_invoice_email WHERE tenant_id=p_tenant AND order_id=p_order;
  recipient:=coalesce(m.recipient,public.event_funnel_invoice_email_recipient(o->'snapshot'));
  RETURN jsonb_build_object('invoices',items,'invoiceMode',o#>>'{snapshot,invoiceMode}',
    'state',CASE WHEN (o->>'payable_minor')::bigint=0 THEN 'not_applicable'
      ELSE coalesce((SELECT state FROM public.event_funnel_delivery
        WHERE tenant_id=p_tenant AND order_id=p_order AND kind='invoices'),'pending') END,
    'email',CASE WHEN (o->>'payable_minor')::bigint=0 OR recipient IS NULL THEN NULL
      ELSE jsonb_build_object('to',recipient,'state',CASE m.state WHEN 'delivered' THEN 'sent'
        WHEN 'writing' THEN 'unconfirmed' WHEN 'needs_review' THEN 'unconfirmed' ELSE 'pending' END) END);
END $$;
COMMIT;
