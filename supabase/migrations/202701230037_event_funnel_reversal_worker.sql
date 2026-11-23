BEGIN;
ALTER TABLE public.event_funnel_reversal
 ADD COLUMN lease_id uuid,ADD COLUMN lease_until timestamptz,
 ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN last_outcomes jsonb;
CREATE INDEX event_funnel_reversal_ready ON public.event_funnel_reversal(next_attempt_at,created_at)
 WHERE refund_options IS NOT NULL AND state IN ('reserved','processing','retry','needs_review');
CREATE FUNCTION public.event_funnel_reversal_claim(p_tenant uuid,p_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_reversal;
BEGIN
 SELECT * INTO r FROM public.event_funnel_reversal
 WHERE (p_tenant IS NULL OR tenant_id=p_tenant) AND (p_id IS NULL OR id=p_id)
   AND refund_options IS NOT NULL AND state IN ('reserved','processing','retry','needs_review')
   AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
 ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL;END IF;
 UPDATE public.event_funnel_reversal SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',
   attempts=attempts+1,state='processing' WHERE id=r.id RETURNING * INTO r;
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION public.event_funnel_reversal_finish(p_tenant uuid,p_order uuid,p_id uuid,p_lease uuid,p_outcomes jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_reversal; final_state text;card bigint;training bigint;voucher bigint;credit bigint;
BEGIN
 SELECT * INTO r FROM public.event_funnel_reversal
 WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_id FOR UPDATE;
 IF NOT FOUND OR p_lease IS NULL OR r.lease_id IS DISTINCT FROM p_lease
   OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() THEN RETURN false;END IF;
 IF jsonb_typeof(p_outcomes) IS DISTINCT FROM 'object' OR NOT p_outcomes ?& ARRAY['card','training','voucher','credit']
   OR EXISTS(SELECT 1 FROM jsonb_each_text(p_outcomes) e WHERE e.key NOT IN ('card','training','voucher','credit')
     OR e.value NOT IN ('complete','not_applicable','retry','needs_review') OR e.value IS NULL) THEN
   RAISE EXCEPTION 'Invalid recovery outcome' USING ERRCODE='22023';
 END IF;
 final_state:=CASE WHEN EXISTS(SELECT 1 FROM jsonb_each_text(p_outcomes) e WHERE e.value='retry') THEN 'retry'
   WHEN EXISTS(SELECT 1 FROM jsonb_each_text(p_outcomes) e WHERE e.value='needs_review') THEN 'needs_review' ELSE 'complete' END;
 IF final_state='complete' THEN
   SELECT sum((value->>'cardMinor')::bigint),sum((value->>'trainingFundMinor')::bigint),
     sum((value->>'voucherMinor')::bigint),sum((value->>'invoiceMinor')::bigint)
   INTO card,training,voucher,credit FROM jsonb_array_elements(r.allocations);
   IF r.cancelled_at IS NULL OR jsonb_typeof(r.stock_receipt) IS DISTINCT FROM 'array'
     OR (card>0 AND (r.card_state<>'complete' OR (r.card_receipt->>'amountMinor')::bigint IS DISTINCT FROM card))
     OR (training>0 AND (r.training_receipt->>'amountMinor')::bigint IS DISTINCT FROM training)
     OR (voucher>0 AND (
       (SELECT coalesce(sum((p->>'amountMinor')::bigint),0) FROM jsonb_array_elements(r.voucher_plan) p)<>voucher
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.voucher_plan) p GROUP BY p->>'allocationId',p->>'voucherId'
         HAVING (r.voucher_receipts->(p->>'allocationId')->>'cumulativeMinor')::bigint IS DISTINCT FROM sum((p->>'amountMinor')::bigint)
           OR r.voucher_receipts->(p->>'allocationId')->>'voucherId' IS DISTINCT FROM p->>'voucherId')))
     OR (credit>0 AND (SELECT coalesce(sum((receipt->>'amountMinor')::bigint),0)
       FROM public.event_funnel_credit_work WHERE tenant_id=p_tenant AND order_id=p_order AND reversal_id=p_id
         AND status='complete')<>credit) THEN
     RAISE EXCEPTION 'Recovery completion requires durable financial receipts' USING ERRCODE='PT409';
   END IF;
 END IF;
 UPDATE public.event_funnel_reversal SET state=final_state,last_outcomes=p_outcomes,lease_id=NULL,lease_until=NULL,
   next_attempt_at=clock_timestamp()+make_interval(secs=>CASE WHEN final_state='needs_review' THEN 900
     ELSE least(3600,5*power(2,least(attempts,10)))::integer END) WHERE id=p_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_reversal_claim(uuid,uuid),
 public.event_funnel_reversal_finish(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_reversal_claim(uuid,uuid),
 public.event_funnel_reversal_finish(uuid,uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
