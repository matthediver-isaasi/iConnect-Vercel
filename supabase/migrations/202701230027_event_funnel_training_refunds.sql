BEGIN;
ALTER TABLE public.event_funnel_reversal ADD COLUMN training_receipt jsonb;
CREATE FUNCTION public.event_funnel_reversal_training(p_tenant uuid,p_order uuid,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_reversal;fund public.event_funnel_training_reservation;
 item jsonb;current_status text;amount bigint;already bigint;balance numeric;receipt jsonb;
BEGIN
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='PT404';END IF;
 SELECT * INTO r FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_id FOR UPDATE;
 IF NOT FOUND OR r.state='released' THEN RAISE EXCEPTION 'Reversal unavailable' USING ERRCODE='PT404';END IF;
 IF r.training_receipt IS NOT NULL THEN RETURN r.training_receipt;END IF;
 SELECT sum((value->>'trainingFundMinor')::bigint) INTO amount FROM jsonb_array_elements(r.allocations);
 FOR item IN SELECT value FROM jsonb_array_elements(r.allocations) LOOP
   IF item->>'source' NOT IN ('booking','complex_event_booking') THEN RAISE EXCEPTION 'Invalid booking source';END IF;
   EXECUTE format('SELECT status FROM public.%I WHERE tenant_id=$1 AND id=$2',item->>'source')
     INTO current_status USING p_tenant,(item->>'id')::uuid;
   IF current_status IS DISTINCT FROM 'cancelled' THEN
     RAISE EXCEPTION 'Registration must be cancelled before funding is restored' USING ERRCODE='PT409';
   END IF;
 END LOOP;
 IF amount>0 THEN
   SELECT * INTO fund FROM public.event_funnel_training_reservation WHERE tenant_id=p_tenant AND order_id=p_order;
   IF NOT FOUND OR fund.state<>'committed' THEN RAISE EXCEPTION 'Original funding unavailable' USING ERRCODE='PT409';END IF;
   SELECT coalesce(sum((training_receipt->>'amountMinor')::bigint),0) INTO already
     FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order;
   IF amount>fund.amount_minor-already THEN RAISE EXCEPTION 'Original funding already restored' USING ERRCODE='PT409';END IF;
   SELECT coalesce(training_fund_balance,0) INTO balance FROM public.organization
     WHERE tenant_id=p_tenant AND id=fund.organization_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original funding owner unavailable' USING ERRCODE='PT409';END IF;
   UPDATE public.organization SET training_fund_balance=balance+amount/100.0 WHERE tenant_id=p_tenant AND id=fund.organization_id;
   INSERT INTO public.training_fund_transaction(tenant_id,organization_id,type,amount,balance_before,balance_after,reason)
     VALUES(p_tenant,fund.organization_id,'cancellation_refund',amount/100.0,balance,balance+amount/100.0,
       'Event checkout reversal '||p_id::text);
 END IF;
 receipt:=jsonb_build_object('amountMinor',amount,'organizationId',fund.organization_id);
 UPDATE public.event_funnel_reversal SET training_receipt=receipt WHERE id=p_id;
 RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_reversal_training(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_reversal_training(uuid,uuid,uuid) TO service_role;
COMMIT;
