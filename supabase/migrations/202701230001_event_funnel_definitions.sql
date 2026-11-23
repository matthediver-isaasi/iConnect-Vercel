-- Staged authoring only. This migration never enables customer purchasing.
BEGIN;
CREATE FUNCTION public.event_funnel_simple_tickets(p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE config jsonb:=p_event->'pricing_config';
BEGIN
  IF config IS NULL OR config='null'::jsonb OR config='""'::jsonb THEN
    RETURN '[{"id":"default","is_group_ticket":false}]'::jsonb;
  END IF;
  IF jsonb_typeof(config)='string' THEN config:=(p_event->>'pricing_config')::jsonb; END IF;
  IF jsonb_typeof(config) IS DISTINCT FROM 'object'
    OR config ? 'ticket_classes' AND jsonb_typeof(config->'ticket_classes') NOT IN ('array','null') THEN
    RAISE EXCEPTION 'Invalid event ticket configuration' USING ERRCODE='22023';
  END IF;
  RETURN CASE WHEN config->'ticket_classes' IS NULL OR config->'ticket_classes'='null'::jsonb
    THEN '[]'::jsonb ELSE config->'ticket_classes' END;
END $$;
CREATE TABLE public.event_funnel_definition (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  revision integer NOT NULL CHECK (revision > 0),
  graph jsonb NOT NULL CHECK (jsonb_typeof(graph)='object'),
  layout jsonb NOT NULL CHECK (jsonb_typeof(layout)='object'),
  published_version_id uuid,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id)
);
CREATE TABLE public.event_funnel_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  definition_revision integer NOT NULL,
  graph jsonb NOT NULL,
  commercial_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,definition_id,id),
  UNIQUE (tenant_id,definition_id,definition_revision),
  FOREIGN KEY (tenant_id,definition_id) REFERENCES public.event_funnel_definition(tenant_id,id)
);
ALTER TABLE public.event_funnel_definition ADD FOREIGN KEY (tenant_id,id,published_version_id)
  REFERENCES public.event_funnel_version(tenant_id,definition_id,id);

CREATE FUNCTION public.event_funnel_version_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'Published funnel versions are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER event_funnel_version_immutable BEFORE UPDATE OR DELETE ON public.event_funnel_version
FOR EACH ROW EXECUTE FUNCTION public.event_funnel_version_immutable();

CREATE TABLE public.event_funnel_rate_limit (
  tenant_id uuid NOT NULL,
  actor text NOT NULL,
  window_started timestamptz NOT NULL,
  requests integer NOT NULL,
  PRIMARY KEY (tenant_id,actor)
);
CREATE FUNCTION public.event_funnel_consume_limit(p_tenant uuid,p_actor text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n integer;
BEGIN
  IF p_tenant IS NULL OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 150 THEN
    RAISE EXCEPTION 'Invalid request identity' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.event_funnel_rate_limit AS r VALUES(p_tenant,p_actor,clock_timestamp(),1)
  ON CONFLICT (tenant_id,actor) DO UPDATE SET
    requests=CASE WHEN r.window_started < clock_timestamp()-interval '1 minute' THEN 1 ELSE r.requests+1 END,
    window_started=CASE WHEN r.window_started < clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE r.window_started END
  RETURNING requests INTO n;
  DELETE FROM public.event_funnel_rate_limit WHERE (tenant_id,actor) IN (
    SELECT tenant_id,actor FROM public.event_funnel_rate_limit
    WHERE window_started < clock_timestamp()-interval '1 day' LIMIT 100
  );
  RETURN n<=60;
END $$;

CREATE FUNCTION public.event_funnel_save_definition(
  p_tenant uuid,p_id uuid,p_actor text,p_expected_revision integer,p_name text,p_graph jsonb,p_layout jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior public.event_funnel_definition; result public.event_funnel_definition;
  node jsonb; ticket text; event_id uuid; event_row jsonb; ticket_found boolean;
BEGIN
  IF p_tenant IS NULL OR p_id IS NULL OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 150
    OR p_expected_revision IS NULL OR p_expected_revision<0
    OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 120
    OR p_graph IS NULL OR jsonb_typeof(p_graph) IS DISTINCT FROM 'object'
    OR p_graph->>'tenantId' IS DISTINCT FROM p_tenant::text
    OR p_graph->>'version' IS DISTINCT FROM '1'
    OR jsonb_typeof(p_graph->'nodes') IS DISTINCT FROM 'array'
    OR p_layout IS NULL OR jsonb_typeof(p_layout) IS DISTINCT FROM 'object'
    OR octet_length(p_graph::text)>262144 OR octet_length(p_layout::text)>65536 THEN
    RAISE EXCEPTION 'Invalid funnel definition' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_graph->'nodes') NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'Invalid node count' USING ERRCODE='22023';
  END IF;
  -- Serialize creation as well as edits. A cross-tenant ID collision never
  -- discloses or overwrites the other tenant's row.
  PERFORM pg_advisory_xact_lock(hashtextextended('event-funnel-definition:'||p_id::text,0));
  SELECT * INTO prior FROM public.event_funnel_definition WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
    IF prior.tenant_id<>p_tenant OR prior.revision<>p_expected_revision THEN
      RAISE EXCEPTION 'Definition changed; reload before saving' USING ERRCODE='PT409';
    END IF;
  ELSIF p_expected_revision<>0 THEN
    RAISE EXCEPTION 'Definition changed; reload before saving' USING ERRCODE='PT409';
  END IF;
  -- The API validates the full domain graph. Database checks independently
  -- reject forged tenant/event/ticket references, including simple JSON tickets.
  FOR node IN SELECT value FROM jsonb_array_elements(p_graph->'nodes') LOOP
    IF node->>'type' IN ('source','event','addon') THEN
      IF node#>>'{event,tenantId}' IS DISTINCT FROM p_tenant::text
        OR coalesce(node#>>'{event,kind}','') NOT IN ('simple','complex')
        OR jsonb_typeof(node->'ticketIds') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Invalid event scope' USING ERRCODE='22023';
      END IF;
      event_id:=(node#>>'{event,id}')::uuid;
      IF node#>>'{event,kind}'='simple' THEN
        SELECT to_jsonb(e) INTO event_row FROM public.event e WHERE e.id=event_id AND e.tenant_id=p_tenant FOR SHARE;
      ELSE
        SELECT to_jsonb(e) INTO event_row FROM public.complex_event e WHERE e.id=event_id AND e.tenant_id=p_tenant FOR SHARE;
      END IF;
      IF event_row IS NULL THEN RAISE EXCEPTION 'Event not found' USING ERRCODE='22023'; END IF;
      IF jsonb_array_length(node->'ticketIds') NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'Invalid ticket selection' USING ERRCODE='22023';
      END IF;
      FOR ticket IN SELECT jsonb_array_elements_text(node->'ticketIds') LOOP
        IF node#>>'{event,kind}'='simple' THEN
          SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(public.event_funnel_simple_tickets(event_row)) t
            WHERE t->>'id'=ticket) INTO ticket_found;
        ELSE
          SELECT EXISTS(SELECT 1 FROM public.complex_event_ticket_class t
            WHERE t.id::text=ticket AND t.complex_event_id=event_id AND t.tenant_id=p_tenant) INTO ticket_found;
        END IF;
        IF NOT ticket_found THEN RAISE EXCEPTION 'Ticket not found' USING ERRCODE='22023'; END IF;
      END LOOP;
    END IF;
  END LOOP;
  INSERT INTO public.event_funnel_definition(id,tenant_id,name,revision,graph,layout,created_by,updated_by)
    VALUES(p_id,p_tenant,btrim(p_name),1,p_graph,p_layout,p_actor,p_actor)
  ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,revision=event_funnel_definition.revision+1,
    graph=EXCLUDED.graph,layout=EXCLUDED.layout,updated_by=p_actor,updated_at=clock_timestamp()
  RETURNING * INTO result;
  RETURN to_jsonb(result);
END $$;

-- Readiness is intentionally fail-closed until shared inventory, payment,
-- recovery and downstream consumers have been installed and verified.
CREATE FUNCTION public.event_funnel_readiness()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT '{"version":1,"authoring":true,"purchasing":false,"reason":"Shared inventory and checkout activation are not ready."}'::jsonb
    || jsonb_build_object('purchasePolicyInstalled',
      to_regprocedure('public.event_funnel_standalone_offer_allowed(uuid,text,uuid,jsonb)') IS NOT NULL)
    || jsonb_build_object('legacyIntentAuthorityInstalled',
      to_regprocedure('public.event_funnel_prepare_legacy_intent(uuid,uuid,text,uuid,jsonb,jsonb)') IS NOT NULL)
$$;

ALTER TABLE public.event_funnel_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_rate_limit ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_funnel_definition_service_read ON public.event_funnel_definition FOR SELECT TO service_role USING (true);
CREATE POLICY event_funnel_version_service_read ON public.event_funnel_version FOR SELECT TO service_role USING (true);
REVOKE ALL ON public.event_funnel_definition,public.event_funnel_version,public.event_funnel_rate_limit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.event_funnel_definition,public.event_funnel_version TO service_role;
REVOKE ALL ON FUNCTION public.event_funnel_version_immutable() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.event_funnel_simple_tickets(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.event_funnel_consume_limit(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.event_funnel_save_definition(uuid,uuid,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.event_funnel_readiness() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_consume_limit(uuid,text),
  public.event_funnel_save_definition(uuid,uuid,text,integer,text,jsonb,jsonb),
  public.event_funnel_readiness() TO service_role;
COMMIT;
