-- Saved only: no automatic application or purchasing activation.
BEGIN;
CREATE TABLE public.event_funnel_invoice_preparation (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  prepared jsonb NOT NULL CHECK(jsonb_typeof(prepared)='array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,order_id),
  FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
ALTER TABLE public.event_funnel_invoice_preparation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_invoice_preparation FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.event_funnel_invoice_input(p_tenant uuid,p_order uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.event_funnel_delivery WHERE tenant_id=p_tenant AND order_id=p_order
    AND kind='invoices' AND state='running' AND lease_token=p_token AND lease_until>clock_timestamp()) THEN
    RAISE EXCEPTION 'Invoice lease unavailable' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order;
  IF NOT FOUND OR o.state<>'confirmed' THEN RAISE EXCEPTION 'Confirmed order unavailable' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('order',to_jsonb(o),'allocations',coalesce((
    SELECT jsonb_agg(to_jsonb(a) ORDER BY a.booking_source,a.booking_id)
    FROM public.event_funnel_order_booking a WHERE tenant_id=p_tenant AND order_id=p_order),'[]'::jsonb),
    'prepared',(SELECT prepared FROM public.event_funnel_invoice_preparation WHERE tenant_id=p_tenant AND order_id=p_order));
END $$;

CREATE FUNCTION public.event_funnel_invoice_capture(p_tenant uuid,p_order uuid,p_token uuid,p_prepared jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE original jsonb; o public.event_funnel_order; total bigint;
BEGIN
  -- Serialize with lease finish/reclaim, and verify again under that lock.
  PERFORM 1 FROM public.event_funnel_delivery WHERE tenant_id=p_tenant AND order_id=p_order
    AND kind='invoices' FOR UPDATE;
  PERFORM public.event_funnel_invoice_input(p_tenant,p_order,p_token);
  SELECT prepared INTO original FROM public.event_funnel_invoice_preparation WHERE tenant_id=p_tenant AND order_id=p_order;
  IF FOUND THEN
    IF original IS DISTINCT FROM p_prepared THEN RAISE EXCEPTION 'Original invoice instructions differ' USING ERRCODE='PT409'; END IF;
    RETURN original;
  END IF;
  SELECT * INTO STRICT o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order;
  IF p_prepared IS NULL OR jsonb_typeof(p_prepared)<>'array'
    OR jsonb_array_length(p_prepared)<1 OR octet_length(p_prepared::text)>1048576 THEN
    RAISE EXCEPTION 'Invalid invoice preparation' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_prepared) j WHERE
    (j->>'tenantId')::uuid IS DISTINCT FROM p_tenant OR (j->>'orderId')::uuid IS DISTINCT FROM p_order
    OR j->>'invoiceMode' IS DISTINCT FROM o.snapshot->>'invoiceMode'
    OR j->>'currency' IS DISTINCT FROM o.currency OR j->>'paymentMethod' IS DISTINCT FROM o.payment_method
    OR j->'contact' IS DISTINCT FROM o.snapshot->'invoiceCustomer'
    OR j->>'status' IS NULL OR j->>'status' NOT IN ('pending','needs_review','not_applicable')
    OR jsonb_typeof(j->'amountMinor') IS DISTINCT FROM 'number' OR (j->>'amountMinor')::bigint<0
    OR jsonb_typeof(j->'events') IS DISTINCT FROM 'array' OR jsonb_array_length(j->'events')<1) THEN
    RAISE EXCEPTION 'Invoice scope mismatch' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_prepared) j WHERE
    (o.snapshot->>'invoiceMode'='per_event' AND jsonb_array_length(j->'events')<>1)
    OR (j->>'amountMinor')::bigint IS DISTINCT FROM
      (SELECT sum((e->>'payableMinor')::bigint) FROM jsonb_array_elements(j->'events') e))
    OR (o.snapshot->>'invoiceMode'='consolidated' AND jsonb_array_length(p_prepared)<>1) THEN
    RAISE EXCEPTION 'Invoice grouping mismatch' USING ERRCODE='22023';
  END IF;
  IF EXISTS(
    WITH supplied AS (
      SELECT e->>'bookingSource' source,(b#>>'{}')::uuid id,(e->>'eventId')::uuid event_id
      FROM jsonb_array_elements(p_prepared) j CROSS JOIN LATERAL jsonb_array_elements(j->'events') e
        CROSS JOIN LATERAL jsonb_array_elements(e->'bookingIds') b
    ), expected AS (
      SELECT booking_source source,booking_id id,event_id FROM public.event_funnel_order_booking
      WHERE tenant_id=p_tenant AND order_id=p_order
    )
    SELECT 1 FROM (
      (SELECT * FROM supplied EXCEPT ALL SELECT * FROM expected)
      UNION ALL (SELECT * FROM expected EXCEPT ALL SELECT * FROM supplied)
    ) mismatch
  ) THEN RAISE EXCEPTION 'Invoice booking links mismatch' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_prepared) j
    CROSS JOIN LATERAL jsonb_array_elements(j->'events') e WHERE
    (e->>'payableMinor')::bigint IS DISTINCT FROM
      (SELECT sum(a.payable_minor) FROM public.event_funnel_order_booking a
        WHERE a.tenant_id=p_tenant AND a.order_id=p_order AND a.event_id=(e->>'eventId')::uuid
          AND a.booking_source=e->>'bookingSource')) THEN
    RAISE EXCEPTION 'Event settlement allocation mismatch' USING ERRCODE='22023';
  END IF;
  SELECT sum((j->>'amountMinor')::bigint) INTO total FROM jsonb_array_elements(p_prepared) j;
  IF total IS DISTINCT FROM o.payable_minor
    OR (SELECT count(DISTINCT j->>'key') FROM jsonb_array_elements(p_prepared) j)<>jsonb_array_length(p_prepared) THEN
    RAISE EXCEPTION 'Invoice allocation mismatch' USING ERRCODE='22023';
  END IF;
  -- Only the service worker can submit preparation; there are no direct table
  -- grants or browser RPC grants. Never overwrite after provider uncertainty.
  INSERT INTO public.event_funnel_invoice_preparation(tenant_id,order_id,prepared)
    VALUES(p_tenant,p_order,p_prepared);
  RETURN p_prepared;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_invoice_input(uuid,uuid,uuid),
  public.event_funnel_invoice_capture(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_invoice_input(uuid,uuid,uuid),
  public.event_funnel_invoice_capture(uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
