BEGIN;
CREATE TABLE public.event_funnel_reversal (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','processing','retry','needs_review','complete','released')),
 allocations jsonb NOT NULL CHECK(jsonb_typeof(allocations)='array' AND jsonb_array_length(allocations)>0),
 card_state text NOT NULL DEFAULT 'reserved' CHECK(card_state IN ('reserved','writing','complete')),
 card_receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
CREATE INDEX event_funnel_reversal_order ON public.event_funnel_reversal(tenant_id,order_id);
ALTER TABLE public.event_funnel_reversal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_reversal FROM PUBLIC,anon,authenticated,service_role;

-- This reserves financial limits, not permission to bypass booking cancellation
-- guards. The application must authorize the original cancellation separately.
CREATE FUNCTION public.event_funnel_reversal_reserve(p_tenant uuid,p_order uuid,p_id uuid,p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order;r public.event_funnel_reversal;b public.event_funnel_order_booking;
 item jsonb;previous jsonb;canonical jsonb:='[]';seen text[]:='{}';identity text;k text;
 requested bigint;used bigint;maximum bigint;
BEGIN
 SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order FOR UPDATE;
 IF o.id IS NULL OR o.state<>'confirmed' OR p_id IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid reversal scope' USING ERRCODE='22023';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'source',(value->>'id')::uuid LOOP
   SELECT * INTO b FROM public.event_funnel_order_booking WHERE tenant_id=p_tenant AND order_id=p_order
     AND booking_source=item->>'source' AND booking_id=(item->>'id')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'Unrelated reversal registration' USING ERRCODE='PT409';END IF;
   identity:=concat(b.booking_source,':',b.booking_id);
   IF identity=ANY(seen) THEN RAISE EXCEPTION 'Duplicate reversal registration' USING ERRCODE='22023';END IF;
   seen:=array_append(seen,identity);
   FOREACH k IN ARRAY ARRAY['cardMinor','invoiceMinor','trainingFundMinor','voucherMinor'] LOOP
     IF coalesce(item->>k,'')!~'^[0-9]+$' THEN RAISE EXCEPTION 'Invalid reversal amount' USING ERRCODE='22023';END IF;
     requested:=(item->>k)::bigint;
     maximum:=CASE k WHEN 'cardMinor' THEN CASE WHEN o.payment_method='card' THEN b.payable_minor ELSE 0 END
       WHEN 'invoiceMinor' THEN b.payable_minor WHEN 'trainingFundMinor' THEN b.training_fund_minor ELSE b.voucher_minor END;
     IF requested>maximum THEN RAISE EXCEPTION 'Reversal exceeds purchased allocation' USING ERRCODE='PT409';END IF;
   END LOOP;
   canonical:=canonical||jsonb_build_array(jsonb_build_object('source',b.booking_source,'id',b.booking_id,
     'cardMinor',(item->>'cardMinor')::bigint,'invoiceMinor',(item->>'invoiceMinor')::bigint,
     'trainingFundMinor',(item->>'trainingFundMinor')::bigint,'voucherMinor',(item->>'voucherMinor')::bigint));
 END LOOP;
 SELECT * INTO r FROM public.event_funnel_reversal WHERE id=p_id;
 IF FOUND THEN
   IF r.tenant_id<>p_tenant OR r.order_id<>p_order OR r.allocations<>canonical THEN
     RAISE EXCEPTION 'Reversal identity already used' USING ERRCODE='PT409';
   END IF;
   RETURN to_jsonb(r);
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(canonical) LOOP
   SELECT * INTO STRICT b FROM public.event_funnel_order_booking WHERE tenant_id=p_tenant AND order_id=p_order
     AND booking_source=item->>'source' AND booking_id=(item->>'id')::uuid;
   FOREACH k IN ARRAY ARRAY['cardMinor','invoiceMinor','trainingFundMinor','voucherMinor'] LOOP
     SELECT coalesce(sum((a.value->>k)::bigint),0) INTO used FROM public.event_funnel_reversal prior
       CROSS JOIN LATERAL jsonb_array_elements(prior.allocations) a
       WHERE prior.tenant_id=p_tenant AND prior.order_id=p_order AND prior.state<>'released'
         AND a.value->>'source'=item->>'source' AND a.value->>'id'=item->>'id';
     maximum:=CASE k WHEN 'cardMinor' THEN CASE WHEN o.payment_method='card' THEN b.payable_minor ELSE 0 END
       WHEN 'invoiceMinor' THEN b.payable_minor WHEN 'trainingFundMinor' THEN b.training_fund_minor ELSE b.voucher_minor END;
     IF (item->>k)::bigint>maximum-used THEN RAISE EXCEPTION 'Reversal amount already reserved' USING ERRCODE='PT409';END IF;
   END LOOP;
 END LOOP;
 INSERT INTO public.event_funnel_reversal(id,tenant_id,order_id,allocations)
   VALUES(p_id,p_tenant,p_order,canonical) RETURNING * INTO r;
 RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.event_funnel_reversal_card(p_tenant uuid,p_order uuid,p_id uuid,p_action text,p_receipt jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_reversal;amount bigint;
BEGIN
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='PT404';END IF;
 SELECT * INTO r FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_id FOR UPDATE;
 IF NOT FOUND OR r.state='released' THEN RAISE EXCEPTION 'Reversal unavailable' USING ERRCODE='PT404';END IF;
 IF p_action='begin' THEN
   IF r.card_state<>'reserved' OR EXISTS(SELECT 1 FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order
     AND id<>p_id AND card_state='writing') THEN RETURN false;END IF;
   UPDATE public.event_funnel_reversal SET card_state='writing',state='processing' WHERE id=p_id;
   RETURN true;
 ELSIF p_action='complete' THEN
   IF r.card_state='complete' THEN RETURN r.card_receipt=p_receipt;END IF;
   SELECT sum((value->>'cardMinor')::bigint) INTO amount FROM jsonb_array_elements(r.allocations);
   IF r.card_state<>'writing' OR jsonb_typeof(p_receipt) IS DISTINCT FROM 'object'
     OR coalesce(p_receipt->>'id','')='' OR (p_receipt->>'amountMinor')::bigint IS DISTINCT FROM amount
     OR upper(p_receipt->>'currency') IS DISTINCT FROM
       (SELECT currency FROM public.event_funnel_order WHERE id=p_order AND tenant_id=p_tenant)
     OR EXISTS(SELECT 1 FROM public.event_funnel_reversal WHERE id<>p_id AND tenant_id=p_tenant
       AND card_receipt->>'id'=p_receipt->>'id')
   THEN RAISE EXCEPTION 'Invalid refund receipt' USING ERRCODE='PT409';END IF;
   UPDATE public.event_funnel_reversal SET card_state='complete',card_receipt=p_receipt WHERE id=p_id;
   -- Other financial legs and cancellation are deliberately not marked complete.
   RETURN true;
 END IF;
 RAISE EXCEPTION 'Unknown reversal action' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_reversal_reserve(uuid,uuid,uuid,jsonb),
 public.event_funnel_reversal_card(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_reversal_reserve(uuid,uuid,uuid,jsonb),
 public.event_funnel_reversal_card(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMIT;
