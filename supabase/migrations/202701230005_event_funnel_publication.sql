-- Publication remains gated by event_funnel_readiness. No customer feature is
-- activated by installing this migration.
BEGIN;
CREATE TABLE public.event_funnel_entry (
  tenant_id uuid NOT NULL,
  event_kind text NOT NULL CHECK(event_kind IN ('simple','complex')),
  event_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  version_id uuid NOT NULL,
  source_node_id text NOT NULL,
  PRIMARY KEY(tenant_id,event_kind,event_id),
  UNIQUE(tenant_id,definition_id),
  FOREIGN KEY(tenant_id,definition_id,version_id)
    REFERENCES public.event_funnel_version(tenant_id,definition_id,id)
);
CREATE TABLE public.event_funnel_offer_policy (
  tenant_id uuid NOT NULL,
  version_id uuid NOT NULL,
  node_id text NOT NULL,
  event_kind text NOT NULL CHECK(event_kind IN ('simple','complex')),
  event_id uuid NOT NULL,
  ticket_ids jsonb NOT NULL CHECK(jsonb_typeof(ticket_ids)='array'),
  unlisted boolean NOT NULL,
  funnel_only boolean NOT NULL,
  prerequisites jsonb NOT NULL CHECK(jsonb_typeof(prerequisites)='array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,version_id,node_id),
  FOREIGN KEY(tenant_id,version_id) REFERENCES public.event_funnel_version(tenant_id,id),
  CHECK(NOT funnel_only OR jsonb_array_length(prerequisites)>0)
);
CREATE INDEX event_funnel_offer_event ON public.event_funnel_offer_policy(tenant_id,event_kind,event_id);

CREATE FUNCTION public.event_funnel_publish(
  p_tenant uuid,p_definition uuid,p_expected_revision integer,p_actor text,p_commercial jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.event_funnel_definition; v public.event_funnel_version; source jsonb; n jsonb; locked record;
BEGIN
  IF public.event_funnel_readiness()->>'purchasing' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Event checkout is not activated' USING ERRCODE='PT409';
  END IF;
  IF p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 150
    OR p_commercial IS NULL OR jsonb_typeof(p_commercial) IS DISTINCT FROM 'object'
    OR p_commercial->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Verified publication evidence required' USING ERRCODE='22023';
  END IF;
  -- Publication changes very rarely. One tenant lock avoids source swaps
  -- deadlocking while preserving exactly one published entry per source.
  PERFORM pg_advisory_xact_lock(hashtextextended('event-funnel-publish:'||p_tenant::text,0));
  SELECT * INTO d FROM public.event_funnel_definition WHERE tenant_id=p_tenant AND id=p_definition FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Definition not found' USING ERRCODE='PT404'; END IF;
  IF d.revision<>p_expected_revision THEN RAISE EXCEPTION 'Definition changed' USING ERRCODE='PT409'; END IF;
  SELECT * INTO v FROM public.event_funnel_version
    WHERE tenant_id=p_tenant AND definition_id=d.id AND definition_revision=d.revision;
  IF FOUND AND d.published_version_id=v.id THEN
    RETURN jsonb_build_object('versionId',v.id,'revision',d.revision,'published',true);
  END IF;
  SELECT value INTO source FROM jsonb_array_elements(d.graph->'nodes')
    WHERE value->>'id'=d.graph->>'entry' AND value->>'type'='source';
  IF source IS NULL THEN RAISE EXCEPTION 'Missing source' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.event_funnel_entry WHERE tenant_id=p_tenant
    AND event_kind=source#>>'{event,kind}' AND event_id=(source#>>'{event,id}')::uuid AND definition_id<>d.id) THEN
    RAISE EXCEPTION 'Another published funnel owns this source' USING ERRCODE='PT409';
  END IF;
  FOR locked IN SELECT DISTINCT value#>>'{event,kind}' kind,(value#>>'{event,id}')::uuid id
    FROM jsonb_array_elements(d.graph->'nodes') WHERE value ? 'event' ORDER BY kind,id LOOP
    PERFORM public.event_funnel_lock_event(p_tenant,locked.kind,locked.id);
    IF (locked.kind='simple' AND NOT EXISTS(SELECT 1 FROM public.event WHERE tenant_id=p_tenant AND id=locked.id))
      OR (locked.kind='complex' AND NOT EXISTS(SELECT 1 FROM public.complex_event WHERE tenant_id=p_tenant AND id=locked.id)) THEN
      RAISE EXCEPTION 'Event no longer available' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF v.id IS NULL THEN
    INSERT INTO public.event_funnel_version(tenant_id,definition_id,definition_revision,graph,commercial_snapshot)
      VALUES(p_tenant,d.id,d.revision,d.graph,p_commercial) RETURNING * INTO v;
  END IF;
  DELETE FROM public.event_funnel_entry WHERE tenant_id=p_tenant AND definition_id=d.id;
  INSERT INTO public.event_funnel_entry VALUES(p_tenant,source#>>'{event,kind}',(source#>>'{event,id}')::uuid,d.id,v.id,source->>'id');
  FOR n IN SELECT value FROM jsonb_array_elements(d.graph->'nodes') WHERE value ? 'event' LOOP
    IF coalesce((n->>'unlisted')::boolean,false) AND n->>'type'<>'event'
      OR coalesce((n->>'funnelOnly')::boolean,false) AND n->>'type'='source' THEN
      RAISE EXCEPTION 'Invalid offer policy' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.event_funnel_offer_policy(tenant_id,version_id,node_id,event_kind,event_id,ticket_ids,unlisted,funnel_only,prerequisites)
      VALUES(p_tenant,v.id,n->>'id',n#>>'{event,kind}',(n#>>'{event,id}')::uuid,n->'ticketIds',
        coalesce((n->>'unlisted')::boolean,false),coalesce((n->>'funnelOnly')::boolean,false),coalesce(n->'requires','[]'))
      ON CONFLICT(tenant_id,version_id,node_id) DO NOTHING;
  END LOOP;
  UPDATE public.event_funnel_definition SET published_version_id=v.id,updated_by=p_actor,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=d.id;
  RETURN jsonb_build_object('versionId',v.id,'revision',d.revision,'published',true);
END $$;

CREATE FUNCTION public.event_funnel_find_entry(p_tenant uuid,p_event_kind text,p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.event_funnel_entry;
BEGIN
  IF public.event_funnel_readiness()->>'purchasing' IS DISTINCT FROM 'true' THEN RETURN '{"active":false}'; END IF;
  SELECT * INTO e FROM public.event_funnel_entry WHERE tenant_id=p_tenant AND event_kind=p_event_kind AND event_id=p_event_id;
  IF NOT FOUND THEN RETURN '{"active":false}'; END IF;
  RETURN jsonb_build_object('active',true,'versionId',e.version_id,'sourceNodeId',e.source_node_id);
END $$;

CREATE FUNCTION public.event_funnel_offer_policies(p_tenant uuid,p_event_kind text,p_event_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('eventId',p.event_id,'ticketIds',p.ticket_ids,
    'unlisted',p.unlisted,'funnelOnly',p.funnel_only)),'[]'::jsonb)
  FROM public.event_funnel_offer_policy p JOIN public.event_funnel_entry e
    ON e.tenant_id=p.tenant_id AND e.version_id=p.version_id
  WHERE p.tenant_id=p_tenant AND p.event_kind=p_event_kind AND p.event_id=ANY(p_event_ids)
    AND cardinality(p_event_ids)<=1000
$$;

CREATE FUNCTION public.event_funnel_offer_capacity(
  p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text,p_node text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_session; g jsonb; n jsonb; e jsonb; state jsonb; kind text; eid uuid;
  tid text; mine bigint; remaining bigint; event_remaining bigint; tickets jsonb:='[]'; live boolean;
BEGIN
  s:=public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
  SELECT graph INTO g FROM public.event_funnel_version WHERE tenant_id=p_tenant AND id=s.version_id;
  SELECT value INTO n FROM jsonb_array_elements(g->'nodes') WHERE value->>'id'=p_node AND value ? 'event';
  IF n IS NULL THEN RAISE EXCEPTION 'Offer unavailable' USING ERRCODE='PT404'; END IF;
  kind:=n#>>'{event,kind}'; eid:=(n#>>'{event,id}')::uuid;
  PERFORM public.event_funnel_lock_event(p_tenant,kind,eid);
  IF kind='simple' THEN SELECT to_jsonb(x) INTO e FROM public.event x WHERE tenant_id=p_tenant AND id=eid;
  ELSE SELECT to_jsonb(x) INTO e FROM public.complex_event x WHERE tenant_id=p_tenant AND id=eid; END IF;
  IF e IS NULL THEN RAISE EXCEPTION 'Offer unavailable' USING ERRCODE='PT404'; END IF;
  live:=s.state IN ('payable','confirming','payment_uncertain') OR s.state='held' AND s.expires_at>clock_timestamp();
  SELECT coalesce(sum(h.places),0) INTO mine FROM public.event_funnel_hold h
    WHERE h.tenant_id=p_tenant AND h.session_id=p_id AND h.node_id=p_node AND live;
  IF kind='simple' AND e->>'capacity_mode'='total' THEN
    state:=public.simple_event_capacity(eid);
    event_remaining:=CASE WHEN state->>'total' IS NULL THEN NULL
      ELSE greatest(0,(state->>'total')::bigint-(state->>'used')::bigint+mine) END;
  ELSIF public.event_funnel_counter_is_finite(kind,e) THEN
    event_remaining:=greatest(0,(e->>'available_seats')::bigint-public.event_funnel_held_places(p_tenant,kind,eid)+mine);
  END IF;
  FOR tid IN SELECT jsonb_array_elements_text(n->'ticketIds') ORDER BY 1 LOOP
    state:=public.sales_capacity_state(kind,eid,tid);
    SELECT coalesce(sum(h.places),0) INTO mine FROM public.event_funnel_hold h
      WHERE h.tenant_id=p_tenant AND h.session_id=p_id AND h.node_id=p_node AND h.ticket_id=tid AND live;
    remaining:=CASE WHEN state->>'unlimited'='true' THEN NULL
      ELSE greatest(0,(state->>'max')::bigint-(state->>'used')::bigint+mine) END;
    tickets:=tickets||jsonb_build_array(jsonb_build_object('ticketId',tid,'remaining',remaining));
  END LOOP;
  RETURN jsonb_build_object('revision',s.revision,'eventRemaining',event_remaining,'tickets',tickets);
END $$;

ALTER TABLE public.event_funnel_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_offer_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_entry,public.event_funnel_offer_policy FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.event_funnel_publish(uuid,uuid,integer,text,jsonb),
  public.event_funnel_find_entry(uuid,text,uuid),public.event_funnel_offer_policies(uuid,text,uuid[]),
  public.event_funnel_offer_capacity(uuid,uuid,uuid,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_publish(uuid,uuid,integer,text,jsonb),
  public.event_funnel_find_entry(uuid,text,uuid),public.event_funnel_offer_policies(uuid,text,uuid[]),
  public.event_funnel_offer_capacity(uuid,uuid,uuid,text,text) TO service_role;
COMMIT;
