BEGIN;
-- A partial cancellation may select specific original vouchers. A total alone
-- must not silently move that approval to another voucher in the purchase.
DO $$
DECLARE definition text; anchor text; replacement text;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_reversal_reserve(uuid,uuid,uuid,jsonb)'::regprocedure) INTO definition;
 anchor:='canonical:=canonical||jsonb_build_array(';
 replacement:=$patch$
 IF item ? 'voucherAmounts' THEN
   IF jsonb_typeof(item->'voucherAmounts') IS DISTINCT FROM 'object' THEN
     RAISE EXCEPTION 'Invalid selected voucher amounts' USING ERRCODE='22023';
   END IF;
   IF EXISTS(SELECT 1 FROM jsonb_each_text(item->'voucherAmounts') e WHERE e.value IS NULL OR e.value!~'^[0-9]+$')
     OR (SELECT coalesce(sum(value::bigint),0) FROM jsonb_each_text(item->'voucherAmounts'))
       IS DISTINCT FROM (item->>'voucherMinor')::bigint
     OR (SELECT count(*)<>count(DISTINCT key::uuid) FROM jsonb_each(item->'voucherAmounts')) THEN
     RAISE EXCEPTION 'Selected voucher amounts do not match the refund' USING ERRCODE='22023';
   END IF;
   item:=jsonb_set(item,'{voucherAmounts}',(
     SELECT coalesce(jsonb_object_agg((key::uuid)::text,value),'{}') FROM jsonb_each(item->'voucherAmounts')));
 END IF;
 canonical:=canonical||jsonb_build_array($patch$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Reversal normalization boundary changed';END IF;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$'voucherMinor',(item->>'voucherMinor')::bigint));$a$;
 replacement:=$b$'voucherMinor',(item->>'voucherMinor')::bigint)
   ||CASE WHEN item ? 'voucherAmounts' THEN jsonb_build_object('voucherAmounts',item->'voucherAmounts') ELSE '{}'::jsonb END);$b$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Reversal snapshot boundary changed';END IF;
 EXECUTE replace(definition,anchor,replacement);

 SELECT pg_get_functiondef('public.event_funnel_reversal_vouchers()'::regprocedure) INTO definition;
 anchor:='IF remaining=0 THEN CONTINUE;END IF;';
 replacement:=$b$IF remaining=0 AND coalesce(item->'voucherAmounts','{}')='{}'::jsonb THEN CONTINUE;END IF;$b$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Zero voucher boundary changed';END IF;
 definition:=replace(definition,anchor,replacement);
 anchor:='FOR part IN SELECT value FROM jsonb_array_elements(registration->''voucherContributions'') LOOP';
 replacement:=$b$
 IF item ? 'voucherAmounts' AND EXISTS(
   SELECT 1 FROM jsonb_object_keys(item->'voucherAmounts') requested
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(registration->'voucherContributions') original
     WHERE (original->>'voucherId')::uuid=requested::uuid)
 ) THEN RAISE EXCEPTION 'Selected voucher did not fund this registration' USING ERRCODE='PT409';END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(registration->'voucherContributions') LOOP$b$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Voucher selection boundary changed';END IF;
 definition:=replace(definition,anchor,replacement);
 anchor:='take:=least(remaining,available);';
 replacement:=$b$take:=CASE WHEN item ? 'voucherAmounts'
   THEN coalesce((item->'voucherAmounts'->>(((part->>'voucherId')::uuid)::text))::bigint,0)
   ELSE least(remaining,available) END;
 IF take>available THEN RAISE EXCEPTION 'Selected voucher share already reserved' USING ERRCODE='PT409';END IF;$b$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Voucher allocation boundary changed';END IF;
 EXECUTE replace(definition,anchor,replacement);
END $$;
COMMIT;
