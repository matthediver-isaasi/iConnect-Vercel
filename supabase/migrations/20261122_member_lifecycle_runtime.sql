BEGIN;
ALTER TABLE public.member_lifecycle_preview ADD COLUMN IF NOT EXISTS source_stamp text;
CREATE TABLE IF NOT EXISTS public.member_lifecycle_preview_roster(
  preview_id uuid NOT NULL REFERENCES public.member_lifecycle_preview(id) ON DELETE CASCADE,
  member_id uuid NOT NULL,
  PRIMARY KEY(preview_id,member_id)
);
CREATE TABLE IF NOT EXISTS public.member_lifecycle_runtime(
  tenant_id uuid PRIMARY KEY,
  approved_preview_id uuid REFERENCES public.member_lifecycle_preview(id),
  approved_revision bigint,
  approved_by text,
  approved_at timestamptz,
  cursor uuid,
  lease_token uuid,
  lease_until timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_error text
);
ALTER TABLE public.member_lifecycle_preview_roster ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_lifecycle_runtime ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_lifecycle_preview_roster,public.member_lifecycle_runtime FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_lifecycle_preview_roster,public.member_lifecycle_runtime TO service_role;
DROP POLICY IF EXISTS lifecycle_roster_service ON public.member_lifecycle_preview_roster;
CREATE POLICY lifecycle_roster_service ON public.member_lifecycle_preview_roster FOR SELECT TO service_role USING(true);
DROP POLICY IF EXISTS lifecycle_runtime_service ON public.member_lifecycle_runtime;
CREATE POLICY lifecycle_runtime_service ON public.member_lifecycle_runtime FOR SELECT TO service_role USING(true);

CREATE OR REPLACE FUNCTION public.member_lifecycle_population(p_tenant_id uuid,p_cursor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]') FROM (
    SELECT m.id FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
      WHERE COALESCE(m.tenant_id,o.tenant_id)=p_tenant_id
      AND m.lifecycle_state<>'deleted' AND (p_cursor IS NULL OR m.id>p_cursor) ORDER BY m.id LIMIT 11
  ) members
$$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_preview_start(p_tenant_id uuid,p_actor text,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v public.member_lifecycle_preview; stamp text;
BEGIN
  stamp:=public.member_lifecycle_source_stamp();
  PERFORM public.member_lifecycle_lock_sources(stamp);
  IF p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200 OR NOT EXISTS(
    SELECT 1 FROM public.member_lifecycle_policy WHERE tenant_id=p_tenant_id AND revision=p_revision) THEN
    RAISE EXCEPTION 'Save and reload configuration before previewing' USING ERRCODE='PT409';
  END IF;
  INSERT INTO public.member_lifecycle_preview(tenant_id,policy_revision,created_by,source_stamp)
    VALUES(p_tenant_id,p_revision,p_actor,stamp) RETURNING * INTO v;
  INSERT INTO public.member_lifecycle_preview_roster(preview_id,member_id)
    SELECT v.id,m.id FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
      WHERE COALESCE(m.tenant_id,o.tenant_id)=p_tenant_id AND m.lifecycle_state<>'deleted';
  RETURN to_jsonb(v);
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_runtime_preview_page(
  p_tenant_id uuid,p_actor text,p_revision bigint,p_preview_id uuid,p_cursor uuid,p_items jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v public.member_lifecycle_preview; expected uuid[]; supplied uuid[]; item jsonb; done boolean;
BEGIN
  SELECT * INTO v FROM public.member_lifecycle_preview WHERE id=p_preview_id
    AND tenant_id=p_tenant_id AND created_by=p_actor FOR UPDATE;
  IF NOT FOUND OR v.policy_revision<>p_revision OR v.complete OR v.expires_at<=now()
    OR v.cursor IS DISTINCT FROM p_cursor OR NOT EXISTS(
      SELECT 1 FROM public.member_lifecycle_policy WHERE tenant_id=p_tenant_id AND revision=p_revision) THEN
    RAISE EXCEPTION 'Preview expired or changed; start again' USING ERRCODE='PT409';
  END IF;
  PERFORM public.member_lifecycle_lock_sources(v.source_stamp);
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>10 THEN
    RAISE EXCEPTION 'Invalid preview page' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(array_agg(member_id ORDER BY member_id),'{}') INTO expected FROM (
    SELECT member_id FROM public.member_lifecycle_preview_roster WHERE preview_id=v.id
      AND (p_cursor IS NULL OR member_id>p_cursor) ORDER BY member_id LIMIT 10
  ) page;
  SELECT COALESCE(array_agg((value->>'memberId')::uuid ORDER BY (value->>'memberId')::uuid),'{}')
    INTO supplied FROM jsonb_array_elements(p_items);
  IF expected IS DISTINCT FROM supplied THEN RAISE EXCEPTION 'Incomplete preview population' USING ERRCODE='PT409'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF COALESCE(item->>'action','') NOT IN ('none','former','guest','archive','deletion_review','evidence_review')
      OR jsonb_typeof(item->'reason') IS DISTINCT FROM 'string' OR octet_length(item::text)>4000 THEN
      RAISE EXCEPTION 'Invalid preview proposal' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.member_lifecycle_preview_item(preview_id,tenant_id,member_id,proposal)
      VALUES(v.id,p_tenant_id,(item->>'memberId')::uuid,item);
  END LOOP;
  v.cursor:=COALESCE(expected[array_length(expected,1)],v.cursor);
  done:=NOT EXISTS(SELECT 1 FROM public.member_lifecycle_preview_roster WHERE preview_id=v.id
    AND (v.cursor IS NULL OR member_id>v.cursor));
  UPDATE public.member_lifecycle_preview SET cursor=v.cursor,complete=done WHERE id=v.id;
  RETURN jsonb_build_object('previewId',v.id,'revision',p_revision,'complete',done,
    'nextCursor',CASE WHEN done THEN NULL ELSE v.cursor END,'expiresAt',v.expires_at,
    'counts',(SELECT COALESCE(jsonb_object_agg(action,n),'{}') FROM(
      SELECT proposal->>'action' action,count(*) n FROM public.member_lifecycle_preview_item WHERE preview_id=v.id GROUP BY 1
    ) counts));
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_control(
  p_tenant_id uuid,p_actor text,p_revision bigint,p_action text,p_preview_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.member_lifecycle_policy; v public.member_lifecycle_preview;
BEGIN
  IF p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200
    OR p_action IS NULL OR p_action NOT IN ('approve','pause') THEN
    RAISE EXCEPTION 'Invalid lifecycle control' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('member-lifecycle-policy:'||p_tenant_id::text,0));
  IF p_action='approve' THEN
    SELECT * INTO v FROM public.member_lifecycle_preview WHERE id=p_preview_id
      AND tenant_id=p_tenant_id AND created_by=p_actor;
    IF NOT FOUND OR NOT v.complete OR v.policy_revision<>p_revision OR v.expires_at<=now() THEN
      RAISE EXCEPTION 'A fresh complete preview is required' USING ERRCODE='PT409';
    END IF;
    PERFORM public.member_lifecycle_lock_sources(v.source_stamp);
  END IF;
  SELECT * INTO p FROM public.member_lifecycle_policy WHERE tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR p.revision<>p_revision THEN RAISE EXCEPTION 'Policy changed; reload' USING ERRCODE='PT409'; END IF;
  IF p_action='approve' THEN
    UPDATE public.member_lifecycle_policy SET enabled=true WHERE tenant_id=p_tenant_id;
    INSERT INTO public.member_lifecycle_runtime(tenant_id,approved_preview_id,approved_revision,approved_by,approved_at)
      VALUES(p_tenant_id,v.id,p_revision,p_actor,now())
      ON CONFLICT(tenant_id) DO UPDATE SET approved_preview_id=v.id,approved_revision=p_revision,
        approved_by=p_actor,approved_at=now(),cursor=NULL,lease_token=NULL,lease_until=NULL,next_run_at=now(),last_error=NULL;
  ELSE
    UPDATE public.member_lifecycle_policy SET enabled=false WHERE tenant_id=p_tenant_id;
    UPDATE public.member_lifecycle_runtime SET lease_token=NULL,lease_until=NULL WHERE tenant_id=p_tenant_id;
  END IF;
  RETURN jsonb_build_object('enabled',p_action='approve','revision',p_revision);
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_claim(p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_lifecycle_runtime;
BEGIN
  IF p_token IS NULL THEN RAISE EXCEPTION 'Lease required'; END IF;
  SELECT runtime.* INTO r FROM public.member_lifecycle_runtime runtime JOIN public.member_lifecycle_policy policy USING(tenant_id)
    WHERE policy.enabled AND runtime.approved_revision=policy.revision
      AND runtime.next_run_at<=now() AND (runtime.lease_until IS NULL OR runtime.lease_until<=now())
    ORDER BY runtime.next_run_at,runtime.tenant_id FOR UPDATE OF runtime SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.member_lifecycle_runtime SET lease_token=p_token,lease_until=now()+interval '2 minutes'
    WHERE tenant_id=r.tenant_id;
  RETURN to_jsonb(r)||jsonb_build_object('lease_token',p_token);
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_checkpoint(
  p_tenant_id uuid,p_token uuid,p_cursor uuid,p_done boolean,p_error text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.member_lifecycle_runtime SET cursor=CASE WHEN p_done THEN NULL ELSE p_cursor END,
    lease_token=NULL,lease_until=NULL,last_run_at=now(),last_error=left(p_error,500),
    next_run_at=now()+CASE WHEN p_error IS NOT NULL THEN interval '5 minutes'
      WHEN p_done THEN interval '1 day' ELSE interval '1 second' END
    WHERE tenant_id=p_tenant_id AND lease_token=p_token AND lease_until>now();
  IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle run lease expired or was paused' USING ERRCODE='PT409'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.member_lifecycle_population(uuid,uuid),
  public.member_lifecycle_preview_start(uuid,text,bigint),
  public.member_lifecycle_runtime_preview_page(uuid,text,bigint,uuid,uuid,jsonb),
  public.member_lifecycle_control(uuid,text,bigint,text,uuid),public.member_lifecycle_claim(uuid),
  public.member_lifecycle_checkpoint(uuid,uuid,uuid,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_population(uuid,uuid),
  public.member_lifecycle_preview_start(uuid,text,bigint),
  public.member_lifecycle_runtime_preview_page(uuid,text,bigint,uuid,uuid,jsonb),
  public.member_lifecycle_control(uuid,text,bigint,text,uuid),public.member_lifecycle_claim(uuid),
  public.member_lifecycle_checkpoint(uuid,uuid,uuid,boolean,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
