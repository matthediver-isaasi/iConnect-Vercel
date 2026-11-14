BEGIN;
CREATE TABLE public.assessment_access_rate_limit (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  client_hash text NOT NULL CHECK (client_hash ~ '^[a-f0-9]{64}$'),
  window_started timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count>0),
  PRIMARY KEY(tenant_id,client_hash)
);
ALTER TABLE public.assessment_access_rate_limit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assessment_access_rate_limit FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.assessment_consume_access_limit(p_tenant uuid,p_client_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_client_hash IS NULL OR p_client_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid rate-limit key'; END IF;
  INSERT INTO public.assessment_access_rate_limit AS limits(tenant_id,client_hash,window_started,request_count)
    VALUES(p_tenant,p_client_hash,clock_timestamp(),1)
    ON CONFLICT (tenant_id,client_hash) DO UPDATE SET
      request_count=CASE WHEN limits.window_started<clock_timestamp()-interval '15 minutes' THEN 1 ELSE least(limits.request_count+1,1000) END,
      window_started=CASE WHEN limits.window_started<clock_timestamp()-interval '15 minutes' THEN clock_timestamp() ELSE limits.window_started END
    RETURNING request_count INTO count;
  -- Bounded maintenance, never a tenant-wide purge on each redemption.
  DELETE FROM public.assessment_access_rate_limit WHERE (tenant_id,client_hash) IN (
    SELECT tenant_id,client_hash FROM public.assessment_access_rate_limit
    WHERE window_started<clock_timestamp()-interval '1 day' LIMIT 100
  );
  RETURN count<=20;
END $$;
REVOKE ALL ON FUNCTION public.assessment_consume_access_limit(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_consume_access_limit(uuid,text) TO service_role;
COMMIT;
