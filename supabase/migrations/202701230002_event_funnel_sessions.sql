-- Private draft ownership. Inventory/payment transitions are separate migrations.
BEGIN;
CREATE TABLE public.event_funnel_session (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  version_id uuid NOT NULL,
  member_id uuid,
  guest_capability_hash text CHECK (guest_capability_hash ~ '^[0-9a-f]{64}$'),
  access_expires_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN
    ('draft','held','expired','payable','confirming','payment_uncertain','confirmed','cancelled')),
  first_reserved_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((member_id IS NULL) <> (guest_capability_hash IS NULL)),
  CHECK (access_expires_at>created_at AND retain_until>=access_expires_at),
  CHECK ((first_reserved_at IS NULL)=(expires_at IS NULL)),
  CHECK (expires_at IS NULL OR expires_at>first_reserved_at),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,version_id) REFERENCES public.event_funnel_version(tenant_id,id)
);
CREATE TABLE public.event_funnel_draft (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  node_id text NOT NULL,
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers)='object' AND octet_length(answers::text)<=65536),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,session_id,node_id),
  FOREIGN KEY (tenant_id,session_id) REFERENCES public.event_funnel_session(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX event_funnel_session_retention ON public.event_funnel_session(retain_until)
  WHERE state IN ('draft','expired','cancelled');

CREATE FUNCTION public.event_funnel_session_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.version_id,NEW.member_id,NEW.guest_capability_hash,NEW.created_at,
      NEW.access_expires_at,NEW.retain_until)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.version_id,OLD.member_id,OLD.guest_capability_hash,OLD.created_at,
      OLD.access_expires_at,OLD.retain_until) THEN
    RAISE EXCEPTION 'Journey ownership and version are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.first_reserved_at IS NOT NULL AND
    ROW(NEW.first_reserved_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.first_reserved_at,OLD.expires_at)
    AND OLD.state<>'expired' THEN
    RAISE EXCEPTION 'Reservation expiry cannot be extended' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_session_identity BEFORE UPDATE ON public.event_funnel_session
FOR EACH ROW EXECUTE FUNCTION public.event_funnel_session_identity();

-- This is an internal service-only ownership primitive. It returns no private
-- data to clients until the caller has supplied server-derived identity.
CREATE FUNCTION public.event_funnel_owned_session(
  p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text
) RETURNS public.event_funnel_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_session;
BEGIN
  SELECT * INTO s FROM public.event_funnel_session WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
  IF NOT FOUND OR s.access_expires_at<=clock_timestamp()
    OR NOT ((s.member_id IS NOT NULL AND p_member IS NOT NULL AND s.member_id=p_member AND p_capability_hash IS NULL)
      OR (s.member_id IS NULL AND p_member IS NULL AND p_capability_hash IS NOT NULL AND s.guest_capability_hash=p_capability_hash)) THEN
    RAISE EXCEPTION 'Journey not available' USING ERRCODE='PT404';
  END IF;
  RETURN s;
END $$;

CREATE FUNCTION public.event_funnel_create_session(
  p_tenant uuid,p_id uuid,p_version uuid,p_member uuid,p_capability_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_session; v public.event_funnel_version; now_at timestamptz:=clock_timestamp();
BEGIN
  IF (public.event_funnel_readiness()->>'purchasing')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Event checkout is not activated' USING ERRCODE='PT409';
  END IF;
  IF p_tenant IS NULL OR p_id IS NULL OR p_version IS NULL
    OR (p_member IS NULL)=(p_capability_hash IS NULL)
    OR (p_capability_hash IS NOT NULL AND p_capability_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'Invalid journey identity' USING ERRCODE='22023';
  END IF;
  IF p_member IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.member WHERE id=p_member AND tenant_id=p_tenant
  ) THEN RAISE EXCEPTION 'Journey not available' USING ERRCODE='PT404'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('event-funnel-session:'||p_id::text,0));
  IF EXISTS(SELECT 1 FROM public.event_funnel_session WHERE id=p_id) THEN
    s:=public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
    IF s.version_id<>p_version THEN RAISE EXCEPTION 'Journey version changed' USING ERRCODE='PT409'; END IF;
    RETURN to_jsonb(s)-'guest_capability_hash';
  END IF;
  SELECT v1.* INTO v FROM public.event_funnel_version v1
    JOIN public.event_funnel_definition d ON d.tenant_id=v1.tenant_id AND d.id=v1.definition_id AND d.published_version_id=v1.id
    WHERE v1.tenant_id=p_tenant AND v1.id=p_version FOR SHARE OF d;
  IF NOT FOUND THEN RAISE EXCEPTION 'Published journey not found' USING ERRCODE='PT404'; END IF;
  INSERT INTO public.event_funnel_session(id,tenant_id,version_id,member_id,guest_capability_hash,access_expires_at,retain_until,created_at)
  VALUES(p_id,p_tenant,p_version,p_member,p_capability_hash,now_at+interval '1 day',now_at+interval '7 days',now_at)
  RETURNING * INTO s;
  RETURN to_jsonb(s)-'guest_capability_hash';
END $$;

CREATE FUNCTION public.event_funnel_read_session(
  p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_session; drafts jsonb; graph jsonb;
BEGIN
  s:=public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
  SELECT v.graph INTO graph FROM public.event_funnel_version v WHERE v.tenant_id=p_tenant AND v.id=s.version_id;
  SELECT coalesce(jsonb_object_agg(d.node_id,d.answers),'{}') INTO drafts FROM public.event_funnel_draft d
    WHERE d.tenant_id=p_tenant AND d.session_id=p_id;
  RETURN jsonb_build_object('session',to_jsonb(s)-'guest_capability_hash','graph',graph,'drafts',drafts,'serverNow',clock_timestamp());
END $$;

CREATE FUNCTION public.event_funnel_save_answers(
  p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text,p_expected_revision integer,p_node text,p_answers jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_session;
BEGIN
  s:=public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
  IF p_expected_revision IS DISTINCT FROM s.revision THEN
    RAISE EXCEPTION 'Journey changed. Reload before editing.' USING ERRCODE='PT409';
  END IF;
  IF s.state NOT IN ('draft','held','expired') THEN
    RAISE EXCEPTION 'Checkout instructions are frozen' USING ERRCODE='PT409';
  END IF;
  IF p_answers IS NULL OR jsonb_typeof(p_answers) IS DISTINCT FROM 'object' OR octet_length(p_answers::text)>65536
    OR NOT EXISTS(SELECT 1 FROM public.event_funnel_version v CROSS JOIN LATERAL jsonb_array_elements(v.graph->'nodes') n
      WHERE v.tenant_id=p_tenant AND v.id=s.version_id AND n->>'id'=p_node AND n->>'type' IN ('source','event','addon')) THEN
    RAISE EXCEPTION 'Invalid draft answers' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.event_funnel_draft(tenant_id,session_id,node_id,answers) VALUES(p_tenant,p_id,p_node,p_answers)
  ON CONFLICT (tenant_id,session_id,node_id) DO UPDATE SET answers=EXCLUDED.answers,updated_at=clock_timestamp();
  UPDATE public.event_funnel_session SET revision=revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=p_id RETURNING * INTO s;
  RETURN to_jsonb(s)-'guest_capability_hash';
END $$;

CREATE FUNCTION public.event_funnel_purge_drafts()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE count_deleted integer;
BEGIN
  -- Never delete payable, uncertain or confirmed financial authority.
  WITH targets AS (
    SELECT id FROM public.event_funnel_session WHERE retain_until<clock_timestamp()
      AND state IN ('draft','expired','cancelled') ORDER BY retain_until,id LIMIT 100 FOR UPDATE SKIP LOCKED
  ), deleted AS (DELETE FROM public.event_funnel_session WHERE id IN (SELECT id FROM targets) RETURNING id)
  SELECT count(*) INTO count_deleted FROM deleted;
  RETURN count_deleted;
END $$;

ALTER TABLE public.event_funnel_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_draft ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_session,public.event_funnel_draft FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.event_funnel_session_identity(), public.event_funnel_owned_session(uuid,uuid,uuid,text),
  public.event_funnel_create_session(uuid,uuid,uuid,uuid,text),public.event_funnel_read_session(uuid,uuid,uuid,text),
  public.event_funnel_save_answers(uuid,uuid,uuid,text,integer,text,jsonb),public.event_funnel_purge_drafts()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_create_session(uuid,uuid,uuid,uuid,text),
  public.event_funnel_read_session(uuid,uuid,uuid,text),public.event_funnel_save_answers(uuid,uuid,uuid,text,integer,text,jsonb),
  public.event_funnel_purge_drafts() TO service_role;
COMMIT;
