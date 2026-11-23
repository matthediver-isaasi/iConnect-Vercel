BEGIN;
-- Narrow service-only projections: never expose prepared payloads, capabilities,
-- provider credentials, other events' attendees, or the shared payment intent.
CREATE FUNCTION public.event_funnel_invoice_report(p_tenant uuid,p_bookings jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF p_tenant IS NULL OR jsonb_typeof(p_bookings) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_bookings)>1000 THEN RAISE EXCEPTION 'Invalid report scope'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'bookingId',b.booking_id,'bookingSource',b.booking_source,'orderId',b.order_id,
    'invoiceMode',o.snapshot->>'invoiceMode','payableMinor',b.payable_minor,
    'provider',w.provider,'invoiceId',w.invoice_id,'invoiceNumber',w.invoice_number,
    'status',coalesce(w.status,d.state,'pending'),'nextAttemptAt',coalesce(w.next_attempt_at,d.next_attempt_at)
  )),'[]'::jsonb) INTO result
  FROM public.event_funnel_order_booking b
  JOIN public.event_funnel_order o ON o.tenant_id=b.tenant_id AND o.id=b.order_id AND o.state='confirmed'
  LEFT JOIN public.event_funnel_invoice_booking l ON l.tenant_id=b.tenant_id
    AND l.booking_source=b.booking_source AND l.booking_id=b.booking_id
  LEFT JOIN public.event_funnel_invoice_work w ON w.id=l.invoice_work_id AND w.tenant_id=b.tenant_id AND w.order_id=b.order_id
  LEFT JOIN public.event_funnel_delivery d ON d.tenant_id=b.tenant_id AND d.order_id=b.order_id AND d.kind='invoices'
  WHERE b.tenant_id=p_tenant AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_bookings) x
    WHERE x->>'id'=b.booking_id::text AND x->>'source'=b.booking_source);
  RETURN result;
END $$;

CREATE FUNCTION public.event_funnel_invoice_download(p_tenant uuid,p_group text,p_member uuid,p_admin boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE orders uuid[];owner_id uuid;invoice_ids uuid[];w public.event_funnel_invoice_work;
BEGIN
  IF p_tenant IS NULL OR p_group IS NULL OR length(p_group) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid invoice scope' USING ERRCODE='PT400';
  END IF;
  SELECT array_agg(DISTINCT b.order_id) INTO orders FROM public.event_funnel_order_booking b
  WHERE b.tenant_id=p_tenant AND (
    b.booking_source='booking' AND EXISTS(SELECT 1 FROM public.booking r
      WHERE r.tenant_id=p_tenant AND r.id=b.booking_id AND r.booking_group_reference=p_group)
    OR b.booking_source='complex_event_booking' AND EXISTS(SELECT 1 FROM public.complex_event_booking r
      WHERE r.tenant_id=p_tenant AND r.id=b.booking_id AND r.booking_group_reference=p_group));
  IF orders IS NULL THEN RETURN NULL; END IF;
  IF cardinality(orders)<>1 THEN RAISE EXCEPTION 'Ambiguous checkout' USING ERRCODE='PT409'; END IF;
  SELECT s.member_id INTO owner_id FROM public.event_funnel_order o
    JOIN public.event_funnel_session s ON s.tenant_id=o.tenant_id AND s.id=o.session_id
    WHERE o.tenant_id=p_tenant AND o.id=orders[1] AND o.state='confirmed';
  -- A co-attendee or organisation colleague is NOT the original purchaser.
  IF p_admin IS DISTINCT FROM true AND (p_member IS NULL OR owner_id IS DISTINCT FROM p_member) THEN
    RAISE EXCEPTION 'Invoice access denied' USING ERRCODE='PT403';
  END IF;
  SELECT array_agg(DISTINCT l.invoice_work_id) INTO invoice_ids
    FROM public.event_funnel_invoice_booking l JOIN public.event_funnel_order_booking b
      ON b.tenant_id=l.tenant_id AND b.booking_source=l.booking_source AND b.booking_id=l.booking_id
    WHERE b.tenant_id=p_tenant AND b.order_id=orders[1] AND (
      b.booking_source='booking' AND EXISTS(SELECT 1 FROM public.booking r
        WHERE r.tenant_id=p_tenant AND r.id=b.booking_id AND r.booking_group_reference=p_group)
      OR b.booking_source='complex_event_booking' AND EXISTS(SELECT 1 FROM public.complex_event_booking r
        WHERE r.tenant_id=p_tenant AND r.id=b.booking_id AND r.booking_group_reference=p_group));
  IF coalesce(cardinality(invoice_ids),0)<>1 THEN
    RAISE EXCEPTION 'Invoice is not yet available' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO w FROM public.event_funnel_invoice_work WHERE id=invoice_ids[1]
    AND tenant_id=p_tenant AND order_id=orders[1] AND status='complete' AND invoice_id IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice is not yet available' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('invoiceId',w.invoice_id,'invoiceNumber',w.invoice_number,'provider',w.provider,
    'companyId',CASE WHEN w.provider='xero' THEN w.xero_tenant_id ELSE w.snapshot#>>'{approvalProvider,realmId}' END,
    'connectionId',CASE WHEN w.provider='xero' THEN w.connection_id ELSE w.snapshot#>>'{approvalProvider,connectionId}' END,
    'environment',w.snapshot->>'environment');
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_invoice_report(uuid,jsonb),
  public.event_funnel_invoice_download(uuid,text,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_invoice_report(uuid,jsonb),
  public.event_funnel_invoice_download(uuid,text,uuid,boolean) TO service_role;
COMMIT;
