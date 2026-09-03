CREATE TABLE IF NOT EXISTS public.address_lookup_rate_limit (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES public.form(id) ON DELETE CASCADE,
  client_key_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, form_id, client_key_hash)
);

ALTER TABLE public.address_lookup_rate_limit ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_address_lookup_rate_limit(
  p_tenant_id uuid,
  p_form_id uuid,
  p_client_key text,
  p_limit integer DEFAULT 20,
  p_window_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_hash text := encode(digest(coalesce(p_client_key, 'unknown'), 'sha256'), 'hex');
  v_count integer;
BEGIN
  IF p_tenant_id IS NULL OR p_form_id IS NULL
     OR p_limit < 1 OR p_limit > 100
     OR p_window_seconds < 10 OR p_window_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid address lookup rate limit input';
  END IF;

  INSERT INTO public.address_lookup_rate_limit (
    tenant_id, form_id, client_key_hash, window_started_at, request_count
  )
  VALUES (p_tenant_id, p_form_id, v_hash, v_now, 1)
  ON CONFLICT (tenant_id, form_id, client_key_hash) DO UPDATE
  SET
    window_started_at = CASE
      WHEN address_lookup_rate_limit.window_started_at
        <= v_now - make_interval(secs => p_window_seconds)
      THEN v_now
      ELSE address_lookup_rate_limit.window_started_at
    END,
    request_count = CASE
      WHEN address_lookup_rate_limit.window_started_at
        <= v_now - make_interval(secs => p_window_seconds)
      THEN 1
      ELSE address_lookup_rate_limit.request_count + 1
    END
  RETURNING request_count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;

REVOKE ALL ON TABLE public.address_lookup_rate_limit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_address_lookup_rate_limit(uuid, uuid, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_address_lookup_rate_limit(uuid, uuid, text, integer, integer)
  TO service_role;