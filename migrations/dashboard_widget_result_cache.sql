-- Task 610. Apply to the verified destination only. No source data is changed.
BEGIN;

CREATE TABLE IF NOT EXISTS public.dashboard_widget_result_cache (
  widget_id uuid PRIMARY KEY REFERENCES public.dashboard_widget(id) ON DELETE CASCADE,
  identity text NOT NULL,
  tenant_id uuid,
  scope text NOT NULL,
  owner_member_id uuid,
  result jsonb,
  updated_at timestamptz,
  last_viewed_at timestamptz,
  due_at timestamptz NOT NULL DEFAULT now(),
  requested_at timestamptz,
  last_explicit_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  last_attempt_at timestamptz,
  failures integer NOT NULL DEFAULT 0,
  error text
);
CREATE INDEX IF NOT EXISTS dashboard_widget_cache_due ON public.dashboard_widget_result_cache(due_at);
CREATE TABLE IF NOT EXISTS public.dashboard_widget_cache_tenants (
  tenant_key text PRIMARY KEY,
  last_served_at timestamptz NOT NULL DEFAULT '-infinity'
);
CREATE TABLE IF NOT EXISTS public.dashboard_widget_refresh_limits (
  actor_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  requests integer NOT NULL
);
ALTER TABLE public.dashboard_widget_result_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_widget_cache_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_widget_refresh_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dashboard_widget_result_cache, public.dashboard_widget_cache_tenants,
  public.dashboard_widget_refresh_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.dashboard_widget_result_cache, public.dashboard_widget_cache_tenants,
  public.dashboard_widget_refresh_limits TO service_role;

CREATE OR REPLACE FUNCTION public.dashboard_widget_cache_identity(w public.dashboard_widget)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
 SELECT md5(jsonb_build_array('widget-cache-v1', w.tenant_id, w.id, w.config,
   w.widget_type, w.scope, w.owner_member_id)::text)
$$;

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
    last_viewed_at = NULL, last_explicit_at = NULL, last_attempt_at = NULL;
  INSERT INTO dashboard_widget_cache_tenants(tenant_key) VALUES(coalesce(NEW.tenant_id::text, 'null'))
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dashboard_widget_cache_sync ON public.dashboard_widget;
CREATE TRIGGER dashboard_widget_cache_sync AFTER INSERT OR UPDATE ON public.dashboard_widget
FOR EACH ROW EXECUTE FUNCTION public.dashboard_widget_cache_sync();
INSERT INTO dashboard_widget_result_cache(widget_id, identity, tenant_id, scope, owner_member_id)
SELECT id, dashboard_widget_cache_identity(w), tenant_id, scope, owner_member_id FROM dashboard_widget w
ON CONFLICT DO NOTHING;
INSERT INTO dashboard_widget_cache_tenants(tenant_key)
SELECT DISTINCT coalesce(tenant_id::text, 'null') FROM dashboard_widget ON CONFLICT DO NOTHING;

-- Revalidate the authorized snapshot while locking the widget before touching cache.
CREATE OR REPLACE FUNCTION public.dashboard_widget_cache_touch(p_widget jsonb, p_actor uuid, p_explicit boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w dashboard_widget; c dashboard_widget_result_cache; n integer; k text;
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
    IF c.last_explicit_at IS NULL OR c.last_explicit_at <= now()-interval '1 minute' THEN
      UPDATE dashboard_widget_result_cache SET
        requested_at=coalesce(requested_at,now()), last_explicit_at=now(),
        due_at=CASE WHEN failures=0 THEN least(due_at,now()) ELSE due_at END
      WHERE widget_id=w.id;
    END IF;
  END IF;
  UPDATE dashboard_widget_result_cache SET last_viewed_at=now()
    WHERE widget_id=w.id RETURNING * INTO c;
  RETURN to_jsonb(c);
END $$;

-- All claimers serialize this tiny critical section, enforcing global/tenant caps.
-- Tenant LRU is durable; an unbounded tenant cannot starve another tenant.
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
  UPDATE dashboard_widget_result_cache SET lease_token=gen_random_uuid(),
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
    due_at=now()+CASE WHEN p_error IS NULL THEN interval '15 minutes'
      ELSE make_interval(secs=>least(3600,30*power(2,least(failures,7)))::integer) END,
    failures=CASE WHEN p_error IS NULL THEN 0 ELSE failures+1 END,
    error=left(p_error,500),lease_token=NULL,
    -- A timed-out JS request cannot cancel every downstream query. Keep its
    -- original 90s exclusion window, longer than the 60s hosting lifetime.
    lease_until=CASE WHEN p_error IS NULL THEN NULL ELSE lease_until END,requested_at=NULL
  WHERE widget_id=p_widget_id AND identity=p_identity AND lease_token=p_token AND lease_until>now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n=1;
END $$;

CREATE OR REPLACE FUNCTION public.dashboard_widget_cache_stats()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE stats jsonb;
BEGIN
  DELETE FROM dashboard_widget_refresh_limits WHERE window_start<now()-interval '1 day';
  DELETE FROM dashboard_widget_cache_tenants t WHERE NOT EXISTS
    (SELECT 1 FROM dashboard_widget_result_cache c WHERE coalesce(c.tenant_id::text,'null')=t.tenant_key);
  SELECT jsonb_build_object('eligible',count(*),'overdue',count(*) FILTER(WHERE due_at<now()),
    'failed',count(*) FILTER(WHERE failures>0),'leased',count(*) FILTER(WHERE lease_until>now()),
    'oldestDueAt',min(due_at) FILTER(WHERE due_at<now()),
    'oldestSuccessfulUpdateAt',min(updated_at)) INTO stats
  FROM dashboard_widget_result_cache WHERE scope='shared' OR last_viewed_at>now()-interval '7 days';
  RETURN stats;
END $$;

REVOKE ALL ON FUNCTION public.dashboard_widget_cache_identity(public.dashboard_widget),
  public.dashboard_widget_cache_sync(),public.dashboard_widget_cache_touch(jsonb,uuid,boolean),
  public.dashboard_widget_cache_claim(uuid,text),public.dashboard_widget_cache_publish(uuid,text,uuid,jsonb,text),
  public.dashboard_widget_cache_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_widget_cache_identity(public.dashboard_widget),
  public.dashboard_widget_cache_sync(),public.dashboard_widget_cache_touch(jsonb,uuid,boolean),
  public.dashboard_widget_cache_claim(uuid,text),public.dashboard_widget_cache_publish(uuid,text,uuid,jsonb,text),
  public.dashboard_widget_cache_stats() TO service_role;
COMMIT;