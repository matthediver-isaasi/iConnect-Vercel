BEGIN;
CREATE TABLE public.member_credit_funding_retry (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL, allocation_id uuid NOT NULL, reference text NOT NULL,
 attempt_key text NOT NULL, not_before timestamptz NOT NULL,
 consumed_at timestamptz,
 UNIQUE(tenant_id,allocation_id,reference,attempt_key),
 FOREIGN KEY(tenant_id,allocation_id,reference)
  REFERENCES public.member_credit_funding_claim(tenant_id,allocation_id,reference)
);
CREATE UNIQUE INDEX member_credit_one_pending_funding_retry
 ON public.member_credit_funding_retry(tenant_id,allocation_id,reference) WHERE consumed_at IS NULL;
ALTER TABLE public.member_credit_funding_retry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_credit_funding_retry FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_credit_funding_retry TO service_role;

ALTER FUNCTION public.claim_member_credit_funding(uuid,uuid,jsonb) RENAME TO claim_member_credit_funding_before_retry;
REVOKE ALL ON FUNCTION public.claim_member_credit_funding_before_retry(uuid,uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.claim_member_credit_funding(p_tenant_id uuid,p_allocation_id uuid,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; retry_row public.member_credit_funding_retry;
BEGIN
 -- The original claim takes the purchase and allocation locks and verifies
 -- committed state, immutable context, ownership and the amount ceiling.
 result:=public.claim_member_credit_funding_before_retry(p_tenant_id,p_allocation_id,p_context);
 IF result->>'existing'='false' THEN RETURN result||'{"attempt":"initial"}'::jsonb; END IF;
 IF EXISTS(SELECT 1 FROM public.member_credit_redemption r WHERE r.tenant_id=p_tenant_id
  AND r.allocation_id=p_allocation_id AND r.reference=p_context->>'reference') THEN RETURN result; END IF;
 SELECT * INTO retry_row FROM public.member_credit_funding_retry
  WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id
   AND reference=p_context->>'reference' AND consumed_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN result; END IF;
 IF retry_row.not_before>now() THEN RETURN result||jsonb_build_object(
  'retryAfter',ceil(extract(epoch FROM retry_row.not_before-now()))); END IF;
 UPDATE public.member_credit_funding_retry SET consumed_at=now() WHERE id=retry_row.id;
 RETURN result||jsonb_build_object('existing',false,'attempt',retry_row.id::text);
END $$;

CREATE FUNCTION public.record_member_credit_funding_throttle(p_tenant_id uuid,p_allocation_id uuid,
 p_reference text,p_attempt text,p_delay_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE claim_row public.member_credit_funding_claim; result public.member_credit_funding_retry;
BEGIN
 SELECT * INTO claim_row FROM public.member_credit_funding_claim
  WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id AND reference=p_reference;
 IF NOT FOUND OR p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 1 AND 86400 THEN
  RAISE EXCEPTION 'A verified funding attempt and bounded retry delay are required'; END IF;
 -- Reuse the original locks; do not consume or grant a retry from this callback.
 PERFORM public.claim_member_credit_funding_before_retry(p_tenant_id,p_allocation_id,claim_row.context);
 SELECT * INTO result FROM public.member_credit_funding_retry
  WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id AND reference=p_reference AND attempt_key=p_attempt;
 IF FOUND THEN RETURN to_jsonb(result); END IF;
 IF p_attempt='initial' THEN
  IF EXISTS(SELECT 1 FROM public.member_credit_funding_retry WHERE tenant_id=p_tenant_id
   AND allocation_id=p_allocation_id AND reference=p_reference) THEN RAISE EXCEPTION 'Stale funding attempt'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM public.member_credit_funding_retry WHERE id::text=p_attempt
  AND tenant_id=p_tenant_id AND allocation_id=p_allocation_id AND reference=p_reference
  AND consumed_at IS NOT NULL) THEN RAISE EXCEPTION 'Unknown funding attempt'; END IF;
 IF EXISTS(SELECT 1 FROM public.member_credit_redemption WHERE tenant_id=p_tenant_id
  AND allocation_id=p_allocation_id AND reference=p_reference) THEN RAISE EXCEPTION 'Funding is already recorded'; END IF;
 INSERT INTO public.member_credit_funding_retry(tenant_id,allocation_id,reference,attempt_key,not_before)
 VALUES(p_tenant_id,p_allocation_id,p_reference,p_attempt,now()+make_interval(secs=>p_delay_seconds))
 RETURNING * INTO result;
 RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION public.claim_member_credit_funding(uuid,uuid,jsonb),
 public.record_member_credit_funding_throttle(uuid,uuid,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_member_credit_funding(uuid,uuid,jsonb),
 public.record_member_credit_funding_throttle(uuid,uuid,text,text,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
