-- Shared by queued and direct Accounting API requests. No plan/tier assumption:
-- day allowance comes from provider headers; reset comes from Retry-After.
CREATE TABLE public.xero_rate_scope (
  app_key text NOT NULL,
  company_id text NOT NULL,
  cooldown_until timestamptz NOT NULL DEFAULT '-infinity',
  headers jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(app_key,company_id)
);
CREATE TABLE public.xero_rate_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_key text NOT NULL,
  company_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '40 seconds',
  finished boolean NOT NULL DEFAULT false
);
CREATE INDEX ON public.xero_rate_request(app_key,started_at);
ALTER TABLE public.xero_rate_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xero_rate_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.xero_rate_scope,public.xero_rate_request FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.xero_rate_reserve(p_app text,p_company text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t timestamptz:=clock_timestamp(); until_at timestamptz; legacy_until timestamptz; n integer; active integer; result_id uuid;
BEGIN
  IF p_app !~ '^[a-f0-9]{64}$' OR p_company IS NULL OR p_company='' OR p_company='PENDING_SELECTION' THEN
    RAISE EXCEPTION 'Invalid Xero quota identity';
  END IF;
  -- All organisation and app reservations/publications share the same lock.
  INSERT INTO xero_rate_scope(app_key,company_id) VALUES(p_app,'') ON CONFLICT DO NOTHING;
  PERFORM 1 FROM xero_rate_scope WHERE app_key=p_app AND company_id='' FOR UPDATE;
  t:=clock_timestamp();
  INSERT INTO xero_rate_scope(app_key,company_id) VALUES(p_app,p_company) ON CONFLICT DO NOTHING;
  SELECT max(cooldown_until) INTO until_at FROM xero_rate_scope
    WHERE app_key=p_app AND company_id IN ('',p_company);
  -- Drain pre-rollout organisation-only pauses; new Xero pauses are scoped
  -- here, not written by queue.finish. Retain old evidence until it expires.
  IF to_regclass('public.accounting_request_binding') IS NOT NULL THEN
    EXECUTE 'SELECT cooldown_until FROM public.accounting_request_binding WHERE provider=''xero'' AND company_id=$1'
      INTO legacy_until USING p_company;
    until_at:=greatest(until_at,legacy_until);
  END IF;
  IF until_at>t THEN
    RETURN jsonb_build_object('retry_after',CASE WHEN until_at='infinity' THEN 2147483648::bigint
      ELSE ceil(extract(epoch FROM until_at-t))::bigint END);
  END IF;
  DELETE FROM xero_rate_request WHERE app_key=p_app AND started_at<=t-interval '60 seconds' AND lease_until<=t;
  SELECT count(*) INTO n FROM xero_rate_request WHERE app_key=p_app AND started_at>t-interval '60 seconds';
  IF n>=10000 THEN RETURN jsonb_build_object('retry_after',60); END IF;
  SELECT count(*) FILTER(WHERE started_at>t-interval '60 seconds'),
    count(*) FILTER(WHERE NOT finished AND lease_until>t)
    INTO n,active FROM xero_rate_request WHERE app_key=p_app AND company_id=p_company;
  IF n>=60 OR active>=5 THEN RETURN jsonb_build_object('retry_after',CASE WHEN active>=5 THEN 40 ELSE 60 END); END IF;
  INSERT INTO xero_rate_request(app_key,company_id) VALUES(p_app,p_company) RETURNING id INTO result_id;
  RETURN jsonb_build_object('id',result_id);
END $$;

CREATE FUNCTION public.xero_rate_finish(p_app text,p_company text,p_id uuid,p_status integer,p_headers jsonb,p_retry integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t timestamptz; pause timestamptz; seconds integer; problem text; app_pause boolean; org_pause boolean;
BEGIN
  PERFORM 1 FROM xero_rate_scope WHERE app_key=p_app AND company_id='' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing Xero quota reservation'; END IF;
  -- No response is not proof the provider stopped working: keep that
  -- concurrent slot until its bounded transport lease expires.
  UPDATE xero_rate_request SET finished=(p_status<>0) WHERE id=p_id AND app_key=p_app AND company_id=p_company AND NOT finished;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid Xero quota reservation'; END IF;
  t:=clock_timestamp();
  problem:=lower(coalesce(p_headers->>'x-rate-limit-problem',''));
  -- Retain only allowlisted quota evidence, never arbitrary provider headers.
  p_headers := (SELECT coalesce(jsonb_object_agg(key,value),'{}') FROM jsonb_each(p_headers)
    WHERE key IN ('retry-after','x-daylimit-remaining','x-minlimit-remaining','x-appminlimit-remaining','x-rate-limit-problem'));
  UPDATE xero_rate_scope SET headers=p_headers WHERE app_key=p_app AND company_id=p_company;
  app_pause:=p_headers->>'x-appminlimit-remaining'='0' OR (p_status=429 AND (problem LIKE '%app%' OR problem=''));
  org_pause:=p_headers->>'x-daylimit-remaining'='0' OR p_headers->>'x-minlimit-remaining'='0'
    OR (p_status=429 AND problem NOT LIKE '%app%');
  seconds:=coalesce(p_retry,CASE WHEN p_headers->>'x-daylimit-remaining'='0' OR problem LIKE '%day%' THEN 86400 ELSE 60 END);
  pause:=CASE WHEN seconds=-1 THEN 'infinity'::timestamptz ELSE t+make_interval(secs=>greatest(1,seconds)) END;
  IF app_pause THEN
    UPDATE xero_rate_scope SET cooldown_until=greatest(cooldown_until,pause),headers=p_headers WHERE app_key=p_app AND company_id='';
  END IF;
  IF org_pause THEN
    UPDATE xero_rate_scope SET cooldown_until=greatest(cooldown_until,pause) WHERE app_key=p_app AND company_id=p_company;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.xero_rate_reserve(text,text),public.xero_rate_finish(text,text,uuid,integer,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.xero_rate_reserve(text,text),public.xero_rate_finish(text,text,uuid,integer,jsonb,integer) TO service_role;
