-- pgcrypto lives in extensions in production, outside this RPC's restricted
-- search_path. Keep the existing counter semantics, signature and grants.
CREATE OR REPLACE FUNCTION public.consume_sales_quote_public_rate_limit(
  p_token_hash_hex text, p_client_key text, p_limit integer, p_window_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_count integer;
  v_window interval;
BEGIN
  IF auth.role() <> 'service_role'
     OR p_token_hash_hex !~ '^[0-9a-f]{64}$'
     OR length(COALESCE(p_client_key, '')) NOT BETWEEN 1 AND 200
     OR p_limit NOT BETWEEN 1 AND 1000
     OR p_window_seconds NOT BETWEEN 1 AND 3600
  THEN
    RAISE EXCEPTION 'invalid public quote rate-limit request' USING ERRCODE='22023';
  END IF;
  v_window := make_interval(secs => p_window_seconds);
  INSERT INTO public.sales_quote_public_rate_limit(
    token_hash, client_key_hash, window_started, request_count, last_seen_at
  ) VALUES (
    decode(p_token_hash_hex, 'hex'), extensions.digest(p_client_key, 'sha256'), now(), 1, now()
  )
  ON CONFLICT (token_hash, client_key_hash) DO UPDATE SET
    request_count = CASE
      WHEN public.sales_quote_public_rate_limit.window_started <= now() - v_window THEN 1
      ELSE public.sales_quote_public_rate_limit.request_count + 1
    END,
    window_started = CASE
      WHEN public.sales_quote_public_rate_limit.window_started <= now() - v_window THEN now()
      ELSE public.sales_quote_public_rate_limit.window_started
    END,
    last_seen_at = now()
  RETURNING request_count INTO v_count;
  DELETE FROM public.sales_quote_public_rate_limit
  WHERE ctid IN (
    SELECT ctid FROM public.sales_quote_public_rate_limit
    WHERE last_seen_at < now() - interval '1 day'
    ORDER BY last_seen_at LIMIT 100
  );
  RETURN v_count > p_limit;
END $$;

REVOKE ALL ON FUNCTION public.consume_sales_quote_public_rate_limit(text,text,integer,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_sales_quote_public_rate_limit(text,text,integer,integer)
  TO service_role;
