BEGIN;
CREATE FUNCTION public.event_funnel_owned_invoices(
  p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text,p_order uuid,p_invoice uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o jsonb;w public.event_funnel_invoice_work;items jsonb;
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
  RETURN jsonb_build_object('invoices',items,'invoiceMode',o#>>'{snapshot,invoiceMode}',
    'state',CASE WHEN (o->>'payable_minor')::bigint=0 THEN 'not_applicable'
      ELSE coalesce((SELECT state FROM public.event_funnel_delivery
        WHERE tenant_id=p_tenant AND order_id=p_order AND kind='invoices'),'pending') END);
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_owned_invoices(uuid,uuid,uuid,text,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_owned_invoices(uuid,uuid,uuid,text,uuid,uuid) TO service_role;
COMMIT;
