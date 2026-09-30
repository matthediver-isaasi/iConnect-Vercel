-- Task 4727: additive receipt protocol; apply only to verified DEST.
BEGIN;
ALTER TABLE public.dashboard_widget_result_cache
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS lease_request_id uuid,
  ADD COLUMN IF NOT EXISTS completed_request_id uuid,
  ADD COLUMN IF NOT EXISTS completed_request_outcome text;
UPDATE public.dashboard_widget_result_cache SET request_id=gen_random_uuid()
  WHERE requested_at IS NOT NULL AND request_id IS NULL;

CREATE OR REPLACE FUNCTION public.dashboard_widget_cache_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND dashboard_widget_cache_identity(OLD) = dashboard_widget_cache_identity(NEW) THEN
    RETURN NEW;
  END IF;
  INSERT INTO dashboard_widget_result_cache(widget_id, identity, tenant_id, scope, owner_member_id)
  VALUES(NEW.id, dashboard_widget_cache_identity(NEW), NEW.tenant_id, NEW.scope, NEW.owner_member_id)
  ON CONFLICT(widget_id) DO UPDATE SET identity = EXCLUDED.identity,
    tenant_id = EXCLUDED.tenant_id, scope = EXCLUDED.scope, owner_member_id = EXCLUDED.owner_member_id,
    result = NULL, updated_at = NULL, due_at = now(), requested_at = NULL,
    lease_token = NULL, lease_until = NULL, failures = 0, error = NULL,
    last_viewed_at = NULL, last_explicit_at = NULL, last_attempt_at = NULL,
    request_id = NULL, lease_request_id = NULL,
    completed_request_id = NULL, completed_request_outcome = NULL;
  INSERT INTO dashboard_widget_cache_tenants(tenant_key) VALUES(coalesce(NEW.tenant_id::text, 'null'))
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.dashboard_widget_cache_touch(p_widget jsonb, p_actor uuid, p_explicit boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w dashboard_widget; c dashboard_widget_result_cache; n integer; k text; outcome text;
BEGIN
  SELECT * INTO w FROM dashboard_widget WHERE id = (p_widget->>'id')::uuid FOR SHARE;
  IF NOT FOUND OR jsonb_build_array(w.tenant_id,w.config,w.widget_type,w.scope,w.owner_member_id)
    IS DISTINCT FROM jsonb_build_array(p_widget->'tenant_id',p_widget->'config',
      p_widget->'widget_type',p_widget->'scope',p_widget->'owner_member_id') THEN
    RAISE EXCEPTION 'Widget changed; reload and try again';
  END IF;
  IF w.scope = 'personal' AND w.owner_member_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'Widget not available';
  END IF;
  SELECT * INTO c FROM dashboard_widget_result_cache WHERE widget_id=w.id FOR UPDATE;
  IF p_explicit THEN
    k := coalesce(w.tenant_id::text,'null') || ':' || p_actor::text;
    INSERT INTO dashboard_widget_refresh_limits(actor_key,window_start,requests) VALUES(k,now(),1)
    ON CONFLICT(actor_key) DO UPDATE SET
      requests=CASE WHEN dashboard_widget_refresh_limits.window_start < now()-interval '1 minute'
        THEN 1 ELSE dashboard_widget_refresh_limits.requests+1 END,
      window_start=CASE WHEN dashboard_widget_refresh_limits.window_start < now()-interval '1 minute'
        THEN now() ELSE dashboard_widget_refresh_limits.window_start END
    RETURNING requests INTO n;
    IF n > 20 THEN RAISE EXCEPTION 'Refresh limit reached; try again in one minute'; END IF;
    IF c.request_id IS NOT NULL THEN
      outcome := 'queued';
    ELSIF c.last_explicit_at IS NULL OR c.last_explicit_at <= now()-interval '1 minute' THEN
      outcome := 'accepted';
      UPDATE dashboard_widget_result_cache SET
        requested_at=now(), request_id=gen_random_uuid(), last_explicit_at=now(),
        due_at=CASE WHEN failures=0 THEN least(due_at,now()) ELSE due_at END
      WHERE widget_id=w.id;
    ELSE
      outcome := 'cooldown';
    END IF;
  END IF;
  UPDATE dashboard_widget_result_cache SET last_viewed_at=now()
    WHERE widget_id=w.id RETURNING * INTO c;
  RETURN to_jsonb(c) || CASE WHEN p_explicit THEN
    jsonb_build_object('refresh',jsonb_build_object('outcome',outcome,'requestId',
      CASE WHEN outcome='cooldown' THEN NULL ELSE c.request_id END))
    ELSE '{}'::jsonb END;
END $$;

CREATE OR REPLACE FUNCTION public.dashboard_widget_cache_claim(p_widget_id uuid DEFAULT NULL, p_identity text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c dashboard_widget_result_cache; w dashboard_widget;
BEGIN
  PERFORM pg_advisory_xact_lock(610, 1);
  IF (SELECT count(*) FROM dashboard_widget_result_cache WHERE lease_until>now()) >= 8 THEN RETURN NULL; END IF;
  SELECT x.* INTO c FROM dashboard_widget_result_cache x
    JOIN dashboard_widget_cache_tenants t ON t.tenant_key=coalesce(x.tenant_id::text,'null')
    WHERE (p_widget_id IS NULL OR (x.widget_id=p_widget_id AND x.identity=p_identity))
      AND x.due_at<=now() AND (x.lease_until IS NULL OR x.lease_until<=now())
      AND (x.scope='shared' OR x.last_viewed_at>now()-interval '7 days')
      AND (SELECT count(*) FROM dashboard_widget_result_cache busy
        WHERE busy.tenant_id IS NOT DISTINCT FROM x.tenant_id AND busy.lease_until>now()) < 2
    ORDER BY t.last_served_at, (x.due_at < now()-interval '15 minutes') DESC,
      (x.requested_at IS NOT NULL) DESC, x.due_at, x.widget_id
    LIMIT 1 FOR UPDATE OF x SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE dashboard_widget_result_cache SET lease_token=gen_random_uuid(), lease_request_id=request_id,
    lease_until=now()+interval '90 seconds',last_attempt_at=now()
    WHERE widget_id=c.widget_id RETURNING * INTO c;
  UPDATE dashboard_widget_cache_tenants SET last_served_at=now()
    WHERE tenant_key=coalesce(c.tenant_id::text,'null');
  SELECT * INTO w FROM dashboard_widget WHERE id=c.widget_id;
  RETURN jsonb_build_object('cache',to_jsonb(c),'widget',to_jsonb(w));
END $$;

CREATE OR REPLACE FUNCTION public.dashboard_widget_cache_publish(p_widget_id uuid, p_identity text,
  p_token uuid, p_result jsonb, p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE dashboard_widget_result_cache SET
    result=CASE WHEN p_error IS NULL THEN p_result ELSE result END,
    updated_at=CASE WHEN p_error IS NULL THEN now() ELSE updated_at END,
    due_at=now()+CASE WHEN p_error IS NULL AND request_id IS DISTINCT FROM lease_request_id
        AND request_id IS NOT NULL THEN interval '0 seconds'
      WHEN p_error IS NULL THEN interval '15 minutes'
      ELSE make_interval(secs=>least(3600,30*power(2,least(failures,7)))::integer) END,
    failures=CASE WHEN p_error IS NULL THEN 0 ELSE failures+1 END,
    error=left(p_error,500),lease_token=NULL,
    -- Preserve exclusion after timeout; a JS timeout cannot cancel every query.
    lease_until=CASE WHEN p_error IS NULL THEN NULL ELSE lease_until END,
    completed_request_id=coalesce(lease_request_id,completed_request_id),
    completed_request_outcome=CASE WHEN lease_request_id IS NOT NULL
      THEN CASE WHEN p_error IS NULL THEN 'success' ELSE 'failed' END ELSE completed_request_outcome END,
    requested_at=CASE WHEN request_id=lease_request_id THEN NULL ELSE requested_at END,
    request_id=CASE WHEN request_id=lease_request_id THEN NULL ELSE request_id END,
    lease_request_id=NULL
  WHERE widget_id=p_widget_id AND identity=p_identity AND lease_token=p_token AND lease_until>now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n=1;
END $$;

REVOKE ALL ON FUNCTION public.dashboard_widget_cache_sync(),
  public.dashboard_widget_cache_touch(jsonb,uuid,boolean),public.dashboard_widget_cache_claim(uuid,text),
  public.dashboard_widget_cache_publish(uuid,text,uuid,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_widget_cache_sync(),
  public.dashboard_widget_cache_touch(jsonb,uuid,boolean),public.dashboard_widget_cache_claim(uuid,text),
  public.dashboard_widget_cache_publish(uuid,text,uuid,jsonb,text) TO service_role;
COMMIT;