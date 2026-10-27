BEGIN;
CREATE TABLE public.member_credit_backing_retry (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 amendment_id uuid NOT NULL REFERENCES public.member_credit_backing_claim(amendment_id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 attempt_key text NOT NULL,
 not_before timestamptz NOT NULL,
 consumed_at timestamptz,
 UNIQUE(amendment_id,attempt_key)
);
CREATE UNIQUE INDEX member_credit_backing_one_retry
 ON public.member_credit_backing_retry(amendment_id) WHERE consumed_at IS NULL;
ALTER TABLE public.member_credit_backing_retry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_credit_backing_retry FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_credit_backing_retry TO service_role;

ALTER FUNCTION public.claim_member_credit_backing(uuid,uuid,uuid,text)
 RENAME TO claim_member_credit_backing_before_retry;
REVOKE ALL ON FUNCTION public.claim_member_credit_backing_before_retry(uuid,uuid,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.claim_member_credit_backing(
 p_tenant_id uuid,p_amendment_id uuid,p_actor_id uuid,p_document_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; retry_row public.member_credit_backing_retry;
 prior public.member_credit_backing_claim;
BEGIN
 result:=public.claim_member_credit_backing_before_retry(p_tenant_id,p_amendment_id,p_actor_id,p_document_id);
 IF result->>'claimed'='true' THEN RETURN result||'{"attempt":"initial"}'::jsonb; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.member_membership_amendment_settlement
   WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id
    AND state IN ('awaiting_payment','uncertain'))
   OR EXISTS(SELECT 1 FROM public.member_membership_amendment_application WHERE amendment_id=p_amendment_id)
 THEN RETURN result; END IF;
 SELECT * INTO retry_row FROM public.member_credit_backing_retry
  WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id AND consumed_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN result; END IF;
 IF retry_row.not_before>now() THEN RETURN result||jsonb_build_object(
  'retryAfter',ceil(extract(epoch FROM retry_row.not_before-now()))); END IF;
 SELECT * INTO prior FROM public.member_credit_backing_claim
  WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id;
 UPDATE public.member_credit_backing_retry SET consumed_at=now() WHERE id=retry_row.id;
 RETURN jsonb_build_object('claimed',true,'attempt',retry_row.id::text,
  'context',prior.context,'documentId',prior.document_id);
END $$;

-- Only trusted server code calls this after the write itself returned HTTP 429.
-- A timeout, process death or an unsuccessful subsequent read is not a grant.
CREATE FUNCTION public.record_member_credit_backing_throttle(
 p_tenant_id uuid,p_amendment_id uuid,p_actor_id uuid,p_attempt text,p_delay_seconds integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior public.member_credit_backing_claim; result public.member_credit_backing_retry;
BEGIN
 SELECT * INTO prior FROM public.member_credit_backing_claim
  WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id;
 IF NOT FOUND OR p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 1 AND 86400 THEN
  RAISE EXCEPTION 'Verified backing attempt and bounded delay required'; END IF;
 PERFORM public.claim_member_credit_backing_before_retry(p_tenant_id,p_amendment_id,p_actor_id,prior.document_id);
 IF NOT EXISTS(SELECT 1 FROM public.member_membership_amendment_settlement
   WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id
    AND state IN ('awaiting_payment','uncertain'))
   OR EXISTS(SELECT 1 FROM public.member_membership_amendment_application WHERE amendment_id=p_amendment_id)
 THEN RAISE EXCEPTION 'Backing is no longer pending'; END IF;
 SELECT * INTO result FROM public.member_credit_backing_retry
  WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id AND attempt_key=p_attempt;
 IF FOUND THEN RETURN to_jsonb(result); END IF;
 IF p_attempt='initial' THEN
  IF EXISTS(SELECT 1 FROM public.member_credit_backing_retry WHERE amendment_id=p_amendment_id)
  THEN RAISE EXCEPTION 'Stale backing attempt'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM public.member_credit_backing_retry
  WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id
   AND id::text=p_attempt AND consumed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Unknown backing attempt';
 END IF;
 INSERT INTO public.member_credit_backing_retry(tenant_id,amendment_id,attempt_key,not_before)
 VALUES(p_tenant_id,p_amendment_id,p_attempt,now()+make_interval(secs=>p_delay_seconds))
 RETURNING * INTO result;
 RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION public.claim_member_credit_backing(uuid,uuid,uuid,text),
 public.record_member_credit_backing_throttle(uuid,uuid,uuid,text,integer)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_member_credit_backing(uuid,uuid,uuid,text),
 public.record_member_credit_backing_throttle(uuid,uuid,uuid,text,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
