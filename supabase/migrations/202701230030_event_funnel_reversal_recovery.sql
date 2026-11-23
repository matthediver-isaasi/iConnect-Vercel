BEGIN;
ALTER TABLE public.event_funnel_reversal ADD COLUMN voucher_receipts jsonb NOT NULL DEFAULT '{}';
CREATE FUNCTION public.event_funnel_reversal_context(p_tenant uuid,p_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order;
BEGIN
 SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order FOR SHARE;
 IF NOT FOUND OR o.state<>'confirmed' THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='PT404';END IF;
 IF (SELECT count(*) FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order)>1000 THEN
   RAISE EXCEPTION 'Reversal history requires reconciliation' USING ERRCODE='PT409';
 END IF;
 RETURN jsonb_build_object('order',to_jsonb(o),
   'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.booking_source,b.booking_id),'[]')
     FROM public.event_funnel_order_booking b WHERE b.tenant_id=p_tenant AND b.order_id=p_order),
   'history',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at,r.id),'[]')
     FROM public.event_funnel_reversal r WHERE r.tenant_id=p_tenant AND r.order_id=p_order));
END $$;
CREATE FUNCTION public.event_funnel_reversal_voucher_receipt(p_tenant uuid,p_order uuid,p_id uuid,p_allocation uuid,p_receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_reversal;amount bigint;voucher uuid;
BEGIN
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='PT404';END IF;
 SELECT * INTO r FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_id FOR UPDATE;
 IF NOT FOUND OR r.state='released' OR r.cancelled_at IS NULL THEN
   RAISE EXCEPTION 'Accepted cancellation unavailable' USING ERRCODE='PT409';
 END IF;
 IF r.voucher_receipts ? p_allocation::text THEN RETURN r.voucher_receipts->p_allocation::text=p_receipt;END IF;
 SELECT sum((value->>'amountMinor')::bigint),min(value->>'voucherId')::uuid INTO amount,voucher
   FROM jsonb_array_elements(r.voucher_plan) WHERE (value->>'allocationId')::uuid=p_allocation;
 IF amount IS NULL OR amount<=0 OR jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR pg_column_size(p_receipt)>65536
   OR (p_receipt->>'cumulativeMinor')::bigint IS DISTINCT FROM amount
   OR (p_receipt->>'voucherId')::uuid IS DISTINCT FROM voucher THEN
   RAISE EXCEPTION 'Voucher refund receipt mismatch' USING ERRCODE='PT409';
 END IF;
 UPDATE public.event_funnel_reversal SET voucher_receipts=jsonb_set(voucher_receipts,ARRAY[p_allocation::text],p_receipt) WHERE id=p_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_reversal_context(uuid,uuid),
 public.event_funnel_reversal_voucher_receipt(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_reversal_context(uuid,uuid),
 public.event_funnel_reversal_voucher_receipt(uuid,uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
