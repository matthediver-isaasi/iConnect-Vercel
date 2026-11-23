BEGIN;
ALTER TABLE public.event_funnel_reversal ADD COLUMN voucher_plan jsonb NOT NULL DEFAULT '[]';
CREATE FUNCTION public.event_funnel_reversal_vouchers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE snapshot jsonb;item jsonb;line jsonb;registration jsonb;part jsonb;plan jsonb:='[]';
 remaining bigint;used bigint;available bigint;take bigint;expected bigint;attributed bigint;allocation uuid;
BEGIN
 SELECT o.snapshot INTO STRICT snapshot FROM public.event_funnel_order o
   WHERE o.tenant_id=NEW.tenant_id AND o.id=NEW.order_id FOR UPDATE;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.allocations) LOOP
   remaining:=(item->>'voucherMinor')::bigint;
   IF remaining=0 THEN CONTINUE;END IF;
   IF snapshot->>'voucherAttributionVersion' IS DISTINCT FROM '1' THEN
     RAISE EXCEPTION 'Original per-registration voucher evidence needs reconciliation' USING ERRCODE='PT409';
   END IF;
   SELECT l.value,r.value INTO STRICT line,registration
     FROM jsonb_array_elements(snapshot->'lines') l
     CROSS JOIN LATERAL jsonb_array_elements(l.value->'registrations') r
     WHERE (r.value->>'id')::uuid=(item->>'id')::uuid
       AND CASE WHEN l.value->>'eventKind'='simple' THEN 'booking' ELSE 'complex_event_booking' END=item->>'source';
   IF jsonb_typeof(registration->'voucherContributions') IS DISTINCT FROM 'array'
     OR (SELECT count(*)<>count(DISTINCT value->>'voucherId') FROM jsonb_array_elements(registration->'voucherContributions'))
     OR (SELECT sum((value->>'amountMinor')::bigint) FROM jsonb_array_elements(registration->'voucherContributions'))
       IS DISTINCT FROM (registration->>'voucherMinor')::bigint THEN
     RAISE EXCEPTION 'Invalid original voucher attribution' USING ERRCODE='PT409';
   END IF;
   FOR part IN SELECT value FROM jsonb_array_elements(registration->'voucherContributions') LOOP
     SELECT a.id INTO allocation FROM public.event_funnel_voucher_reservation f
       JOIN public.voucher_credit_allocation a ON a.tenant_id=f.tenant_id AND a.purchase_id=f.purchase_id AND a.voucher_id=f.voucher_id
       WHERE f.tenant_id=NEW.tenant_id AND f.order_id=NEW.order_id AND f.voucher_id=(part->>'voucherId')::uuid AND f.state='committed';
     IF allocation IS NULL OR (part->>'amountMinor')::bigint<=0 THEN
       RAISE EXCEPTION 'Original voucher allocation unavailable' USING ERRCODE='PT409';
     END IF;
     SELECT sum((p.value->>'amountMinor')::bigint) INTO expected
       FROM jsonb_array_elements(snapshot->'voucherAllocations') v CROSS JOIN LATERAL jsonb_array_elements(v.value->'lines') p
       WHERE v.value->>'voucherId'=part->>'voucherId' AND p.value->>'nodeId'=line->>'nodeId'
         AND p.value->>'ticketId'=line->>'ticketId';
     SELECT sum((p.value->>'amountMinor')::bigint) INTO attributed
       FROM jsonb_array_elements(line->'registrations') r CROSS JOIN LATERAL jsonb_array_elements(r.value->'voucherContributions') p
       WHERE p.value->>'voucherId'=part->>'voucherId';
     IF expected IS NULL OR attributed IS DISTINCT FROM expected THEN
       RAISE EXCEPTION 'Voucher attribution moved between event lines' USING ERRCODE='PT409';
     END IF;
     SELECT coalesce(sum((p.value->>'amountMinor')::bigint),0) INTO used
       FROM public.event_funnel_reversal prior CROSS JOIN LATERAL jsonb_array_elements(prior.voucher_plan) p
       WHERE prior.tenant_id=NEW.tenant_id AND prior.order_id=NEW.order_id AND prior.state<>'released'
         AND p.value->>'source'=item->>'source' AND p.value->>'bookingId'=item->>'id'
         AND p.value->>'voucherId'=part->>'voucherId';
     available:=(part->>'amountMinor')::bigint-used;
     IF available<0 THEN RAISE EXCEPTION 'Voucher reversal history exceeds its original share' USING ERRCODE='PT409';END IF;
     take:=least(remaining,available);
     IF take>0 THEN
       plan:=plan||jsonb_build_array(jsonb_build_object('source',item->>'source','bookingId',item->>'id',
         'voucherId',part->>'voucherId','allocationId',allocation,'amountMinor',take));
       remaining:=remaining-take;
     END IF;
   END LOOP;
   IF remaining<>0 THEN RAISE EXCEPTION 'Voucher amount already reserved' USING ERRCODE='PT409';END IF;
 END LOOP;
 NEW.voucher_plan:=plan;
 RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_reversal_vouchers BEFORE INSERT ON public.event_funnel_reversal
 FOR EACH ROW EXECUTE FUNCTION public.event_funnel_reversal_vouchers();
REVOKE ALL ON FUNCTION public.event_funnel_reversal_vouchers() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
