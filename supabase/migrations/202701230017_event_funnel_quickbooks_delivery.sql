-- Unapplied. Requires the shared accounting queue and funnel invoice journal.
-- No change to historical single-event settlement ownership.
BEGIN;
CREATE FUNCTION public.event_funnel_quickbooks_handoff(p_tenant uuid,p_order uuid,p_token uuid,p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE w public.event_funnel_invoice_work; q public.accounting_request_queue;
BEGIN
  PERFORM public.event_funnel_invoice_input(p_tenant,p_order,p_token);
  SELECT * INTO w FROM public.event_funnel_invoice_work
    WHERE tenant_id=p_tenant AND order_id=p_order AND allocation_key=p_key;
  IF NOT FOUND OR w.provider<>'quickbooks' OR w.snapshot IS NULL
    OR w.snapshot#>>'{linkage,source}' IS DISTINCT FROM 'event_funnel'
    OR w.snapshot#>>'{linkage,group}' IS DISTINCT FROM w.allocation_key
    OR (w.snapshot#>>'{linkage,orderId}')::uuid IS DISTINCT FROM w.order_id THEN
    RAISE EXCEPTION 'Original QuickBooks instructions unavailable' USING ERRCODE='PT409';
  END IF;
  IF w.status='not_applicable' THEN RETURN jsonb_build_object('status','not_applicable'); END IF;
  IF w.status='needs_review' THEN RETURN jsonb_build_object('status','needs_review'); END IF;
  -- The shared queue owns provider requests, discovery, company cooldown and
  -- idempotency; the funnel journal owns event allocations and booking links.
  SELECT * INTO q FROM public.accounting_request_enqueue(
    w.tenant_id,'quickbooks',w.snapshot#>>'{approvalProvider,connectionId}',
    w.snapshot#>>'{approvalProvider,realmId}','event_funnel',w.allocation_key,'invoice',w.snapshot);
  IF q.snapshot IS DISTINCT FROM w.snapshot OR q.tenant_id<>w.tenant_id
    OR q.provider<>'quickbooks' OR q.company_id IS DISTINCT FROM w.snapshot#>>'{approvalProvider,realmId}'
    OR q.connection_id IS DISTINCT FROM w.snapshot#>>'{approvalProvider,connectionId}' THEN
    RAISE EXCEPTION 'Original QuickBooks request differs' USING ERRCODE='PT409';
  END IF;
  IF q.state='review' THEN
    UPDATE public.event_funnel_invoice_work SET status='needs_review',reason_code='quickbooks_request_requires_review'
      WHERE id=w.id AND status<>'complete';
  END IF;
  IF q.state='complete' AND w.status<>'complete' THEN
    RAISE EXCEPTION 'QuickBooks booking links are incomplete' USING ERRCODE='PT409';
  END IF;
  RETURN jsonb_build_object('requestId',q.id,'status',CASE
    WHEN q.state='complete' THEN 'complete' WHEN q.state='review' THEN 'needs_review' ELSE 'pending' END);
END $$;

CREATE FUNCTION public.event_funnel_quickbooks_guard(p_id uuid,p_token uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.accounting_request_queue q
    JOIN public.event_funnel_invoice_work w ON w.tenant_id=q.tenant_id AND w.allocation_key=q.source_id
    JOIN public.event_funnel_order o ON o.tenant_id=w.tenant_id AND o.id=w.order_id
    WHERE q.id=p_id AND q.lease_token=p_token AND q.state='running' AND q.lease_until>clock_timestamp()
      AND q.source_type='event_funnel' AND q.provider='quickbooks' AND q.operation='invoice'
      AND w.provider='quickbooks' AND o.state='confirmed' AND q.snapshot=w.snapshot
      AND q.connection_id=w.snapshot#>>'{approvalProvider,connectionId}'
      AND q.company_id=w.snapshot#>>'{approvalProvider,realmId}'
      AND (w.invoice_id IS NULL OR w.invoice_id=q.invoice_result->>'id')
      AND (w.payment_id IS NULL OR w.payment_id=q.payment_result->>'id')
  )
$$;

CREATE FUNCTION public.event_funnel_quickbooks_link(p_id uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE q public.accounting_request_queue; w public.event_funnel_invoice_work;
  original jsonb; e jsonb; booking_value jsonb; a public.event_funnel_order_booking; linked_work uuid;
BEGIN
  SELECT * INTO q FROM public.accounting_request_queue WHERE id=p_id FOR UPDATE;
  IF NOT public.event_funnel_quickbooks_guard(p_id,p_token) OR q.invoice_status<>'done'
    OR q.payment_status NOT IN ('done','skipped') OR coalesce(q.invoice_result->>'id','')=''
    OR (q.snapshot->'payment'<>'null'::jsonb AND
      (q.payment_status<>'done' OR coalesce(q.payment_result->>'id','')='')) THEN
    RAISE EXCEPTION 'Verified QuickBooks results required' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO STRICT w FROM public.event_funnel_invoice_work
    WHERE tenant_id=q.tenant_id AND allocation_key=q.source_id FOR UPDATE;
  SELECT j INTO original FROM public.event_funnel_invoice_preparation p
    CROSS JOIN LATERAL jsonb_array_elements(p.prepared) j
    WHERE p.tenant_id=w.tenant_id AND p.order_id=w.order_id AND j->>'key'=w.allocation_key;
  IF original IS NULL OR original->'snapshot' IS DISTINCT FROM w.snapshot THEN
    RAISE EXCEPTION 'Original invoice allocation unavailable' USING ERRCODE='PT409';
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(original->'events') LOOP
    FOR booking_value IN SELECT value FROM jsonb_array_elements(e->'bookingIds') LOOP
      SELECT * INTO STRICT a FROM public.event_funnel_order_booking
        WHERE tenant_id=w.tenant_id AND order_id=w.order_id AND booking_source=e->>'bookingSource'
          AND booking_id=(booking_value#>>'{}')::uuid;
      INSERT INTO public.event_funnel_invoice_booking(invoice_work_id,tenant_id,booking_source,booking_id,amount_minor)
        VALUES(w.id,w.tenant_id,a.booking_source,a.booking_id,a.payable_minor)
        ON CONFLICT(tenant_id,booking_source,booking_id) DO NOTHING;
      SELECT invoice_work_id INTO linked_work FROM public.event_funnel_invoice_booking
        WHERE tenant_id=w.tenant_id AND booking_source=a.booking_source AND booking_id=a.booking_id;
      IF linked_work IS DISTINCT FROM w.id THEN RAISE EXCEPTION 'Booking already has another invoice' USING ERRCODE='PT409'; END IF;
    END LOOP;
  END LOOP;
  UPDATE public.event_funnel_invoice_work SET status='complete',invoice_id=q.invoice_result->>'id',
    invoice_number=coalesce(q.invoice_result->>'invoiceNumber',q.invoice_result->>'invoice_number'),
    payment_id=q.payment_result->>'id',next_attempt_at=NULL,reason_code=NULL WHERE id=w.id;
  RETURN jsonb_build_object('linked',true);
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_quickbooks_handoff(uuid,uuid,uuid,text),
  public.event_funnel_quickbooks_guard(uuid,uuid),public.event_funnel_quickbooks_link(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_quickbooks_handoff(uuid,uuid,uuid,text),
  public.event_funnel_quickbooks_guard(uuid,uuid),public.event_funnel_quickbooks_link(uuid,uuid) TO service_role;
COMMIT;
