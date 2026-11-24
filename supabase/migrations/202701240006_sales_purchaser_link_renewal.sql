BEGIN;
ALTER TABLE public.sales_customer_fulfilment ADD COLUMN token_generation integer NOT NULL DEFAULT 0 CHECK(token_generation>=0);
ALTER FUNCTION public.claim_sales_customer_fulfilment(uuid,text,uuid) RENAME TO claim_sales_customer_fulfilment_legacy;
REVOKE ALL ON FUNCTION public.claim_sales_customer_fulfilment_legacy(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.claim_sales_customer_fulfilment(p_id uuid,p_hash text,p_lease uuid,p_generation integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.sales_customer_fulfilment WHERE id=p_id AND token_generation=p_generation FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN public.claim_sales_customer_fulfilment_legacy(p_id,p_hash,p_lease);
END $fn$;
REVOKE ALL ON FUNCTION public.claim_sales_customer_fulfilment(uuid,text,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sales_customer_fulfilment(uuid,text,uuid,integer) TO service_role;
CREATE OR REPLACE FUNCTION public.guard_sales_customer_fulfilment() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN
  IF (NEW.tenant_id,NEW.sale_id,NEW.customer_email,NEW.customer_name)
    IS DISTINCT FROM (OLD.tenant_id,OLD.sale_id,OLD.customer_email,OLD.customer_name) THEN
    RAISE EXCEPTION 'Accepted customer fulfilment identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.token_generation=OLD.token_generation+1 AND OLD.status='sent'
    AND OLD.expires_at<=clock_timestamp() AND OLD.revoked_at IS NULL
    AND NEW.status='pending' AND NEW.token_hash IS NULL AND NEW.sent_at IS NULL
    AND NEW.expires_at>clock_timestamp() THEN RETURN NEW; END IF;
  IF NEW.token_generation<>OLD.token_generation OR NEW.expires_at<>OLD.expires_at
    OR (OLD.token_hash IS NOT NULL AND NEW.token_hash IS DISTINCT FROM OLD.token_hash) THEN
    RAISE EXCEPTION 'Registration token identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE FUNCTION public.renew_sales_customer_fulfilment(p_tenant uuid,p_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  UPDATE public.sales_customer_fulfilment SET token_generation=token_generation+1,
    expires_at=clock_timestamp()+interval '30 days',status='pending',sent_at=NULL,token_hash=NULL,
    lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),last_error=NULL
  WHERE tenant_id=p_tenant AND token_hash=p_hash AND expires_at<=clock_timestamp()
    AND status='sent' AND revoked_at IS NULL;
  -- Always return the same response. A renewed bearer is sent only to the frozen
  -- purchaser; the expired token never becomes usable again.
END $fn$;
REVOKE ALL ON FUNCTION public.renew_sales_customer_fulfilment(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.renew_sales_customer_fulfilment(uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
