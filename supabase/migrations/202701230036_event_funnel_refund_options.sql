BEGIN;
ALTER TABLE public.event_funnel_reversal ADD COLUMN refund_options jsonb
 CHECK(refund_options IS NULL OR jsonb_typeof(refund_options)='object');

-- The endpoint must authorize the cancellation and replacement policy before
-- calling this RPC. Reservation and the immutable policy snapshot commit together.
CREATE FUNCTION public.event_funnel_reversal_authorize(
 p_tenant uuid,p_order uuid,p_id uuid,p_items jsonb,p_options jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE r public.event_funnel_reversal; replacement jsonb; canonical jsonb; seen uuid[]:='{}'; voucher uuid;
BEGIN
 IF jsonb_typeof(p_options) IS DISTINCT FROM 'object' OR octet_length(p_options::text)>65536
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_options) k WHERE k<>'voucherReplacements')
   OR jsonb_typeof(coalesce(p_options->'voucherReplacements','[]')) IS DISTINCT FROM 'array'
   OR jsonb_array_length(coalesce(p_options->'voucherReplacements','[]'))>1000 THEN
   RAISE EXCEPTION 'Invalid refund options' USING ERRCODE='22023';
 END IF;
 PERFORM public.event_funnel_reversal_reserve(p_tenant,p_order,p_id,p_items);
 SELECT * INTO STRICT r FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_id FOR UPDATE;
 FOR replacement IN SELECT value FROM jsonb_array_elements(coalesce(p_options->'voucherReplacements','[]')) LOOP
   IF jsonb_typeof(replacement) IS DISTINCT FROM 'object'
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(replacement) k WHERE k NOT IN ('voucherId','newExpiryDate'))
     OR jsonb_typeof(replacement->'newExpiryDate') IS DISTINCT FROM 'string'
     OR length(replacement->>'newExpiryDate') NOT BETWEEN 10 AND 40 THEN
     RAISE EXCEPTION 'Invalid replacement policy' USING ERRCODE='22023';
   END IF;
   voucher:=(replacement->>'voucherId')::uuid;
   IF voucher IS NULL OR voucher=ANY(seen) OR NOT EXISTS(
     SELECT 1 FROM jsonb_array_elements(r.voucher_plan) p WHERE (p->>'voucherId')::uuid=voucher
   ) THEN RAISE EXCEPTION 'Replacement does not belong to this refund' USING ERRCODE='PT409';END IF;
   seen:=array_append(seen,voucher);
   IF NOT isfinite((replacement->>'newExpiryDate')::timestamptz)
     OR (r.refund_options IS NULL AND (replacement->>'newExpiryDate')::timestamptz<=clock_timestamp()) THEN
     RAISE EXCEPTION 'Replacement requires an approved future expiry' USING ERRCODE='22023';
   END IF;
 END LOOP;
 SELECT jsonb_build_object('voucherReplacements',coalesce(jsonb_agg(value ORDER BY value->>'voucherId'),'[]'))
 INTO canonical FROM jsonb_array_elements(coalesce(p_options->'voucherReplacements','[]'));
 IF r.refund_options IS NOT NULL THEN
   IF r.refund_options<>canonical THEN RAISE EXCEPTION 'Approved refund options cannot change' USING ERRCODE='PT409';END IF;
 ELSIF r.cancelled_at IS NOT NULL OR r.state<>'reserved' OR r.card_state<>'reserved' THEN
   RAISE EXCEPTION 'Started refund requires original policy evidence' USING ERRCODE='PT409';
 ELSE
   UPDATE public.event_funnel_reversal SET refund_options=canonical WHERE id=p_id RETURNING * INTO r;
 END IF;
 RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_reversal_authorize(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_reversal_authorize(uuid,uuid,uuid,jsonb,jsonb) TO service_role;
COMMIT;
