-- Funnel Groups and event-side funnel links. Additive.
-- * Administrators group funnel definitions (one group per funnel, no nesting).
-- * An event may link to one funnel OR one Funnel Group (or neither). When a
--   link exists, entry resolution only considers in-scope published funnels;
--   without a link behaviour is unchanged.
-- * Deleting a group explicitly clears event links that pointed at it (inside
--   the delete RPC); funnel definitions referenced by links cannot be deleted
--   (FK NO ACTION).
BEGIN;
CREATE TABLE public.event_funnel_collection (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX event_funnel_collection_name ON public.event_funnel_collection(tenant_id, lower(btrim(name)));

CREATE TABLE public.event_funnel_collection_member (
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, definition_id),
  FOREIGN KEY (tenant_id, definition_id) REFERENCES public.event_funnel_definition(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, collection_id) REFERENCES public.event_funnel_collection(tenant_id, id)
);
CREATE INDEX event_funnel_collection_member_collection ON public.event_funnel_collection_member(tenant_id, collection_id);

CREATE TABLE public.event_funnel_event_link (
  tenant_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('simple','complex')),
  event_id uuid NOT NULL,
  definition_id uuid,
  collection_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, event_kind, event_id),
  CHECK (definition_id IS NULL OR collection_id IS NULL),
  FOREIGN KEY (tenant_id, definition_id) REFERENCES public.event_funnel_definition(tenant_id, id),
  FOREIGN KEY (tenant_id, collection_id) REFERENCES public.event_funnel_collection(tenant_id, id)
);
CREATE INDEX event_funnel_event_link_definition ON public.event_funnel_event_link(tenant_id, definition_id) WHERE definition_id IS NOT NULL;
CREATE INDEX event_funnel_event_link_collection ON public.event_funnel_event_link(tenant_id, collection_id) WHERE collection_id IS NOT NULL;

ALTER TABLE public.event_funnel_collection ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_collection_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_event_link ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_collection, public.event_funnel_collection_member, public.event_funnel_event_link
  FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY event_funnel_collection_read ON public.event_funnel_collection FOR SELECT TO service_role USING (true);
CREATE POLICY event_funnel_collection_member_read ON public.event_funnel_collection_member FOR SELECT TO service_role USING (true);
CREATE POLICY event_funnel_event_link_read ON public.event_funnel_event_link FOR SELECT TO service_role USING (true);
GRANT SELECT ON public.event_funnel_collection, public.event_funnel_collection_member, public.event_funnel_event_link TO service_role;

CREATE FUNCTION public.event_funnel_actor_ok(p_actor text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT p_actor IS NOT NULL AND length(btrim(p_actor)) BETWEEN 1 AND 150
$$;

-- Create (p_revision = 0, p_id supplied by the caller) or rename.
CREATE FUNCTION public.event_funnel_collection_save(p_tenant uuid, p_id uuid, p_name text, p_revision integer, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.event_funnel_collection;
BEGIN
  IF p_tenant IS NULL OR p_id IS NULL OR p_revision IS NULL OR p_revision < 0 OR NOT public.event_funnel_actor_ok(p_actor)
    OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Invalid funnel group' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM public.event_funnel_collection WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
  IF coalesce(c.revision, 0) <> p_revision THEN RAISE EXCEPTION 'Funnel group changed' USING ERRCODE='PT409'; END IF;
  IF EXISTS (SELECT 1 FROM public.event_funnel_collection WHERE tenant_id=p_tenant AND id<>p_id
    AND lower(btrim(name))=lower(btrim(p_name))) THEN
    RAISE EXCEPTION 'A funnel group with this name already exists.' USING ERRCODE='PT409';
  END IF;
  IF c.id IS NULL THEN
    INSERT INTO public.event_funnel_collection(tenant_id, id, name, updated_by)
      VALUES (p_tenant, p_id, btrim(p_name), p_actor) RETURNING * INTO c;
  ELSE
    UPDATE public.event_funnel_collection SET name=btrim(p_name), revision=revision+1, updated_by=p_actor,
      updated_at=clock_timestamp() WHERE tenant_id=p_tenant AND id=p_id RETURNING * INTO c;
  END IF;
  RETURN to_jsonb(c);
END $$;

-- Deleting a group removes its memberships and explicitly clears event links
-- that pointed at it (those events revert to unscoped funnel routing).
CREATE FUNCTION public.event_funnel_collection_delete(p_tenant uuid, p_id uuid, p_revision integer, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.event_funnel_collection; cleared integer;
BEGIN
  IF p_tenant IS NULL OR p_id IS NULL OR p_revision IS NULL OR NOT public.event_funnel_actor_ok(p_actor) THEN
    RAISE EXCEPTION 'Invalid funnel group' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('event-funnel-publish:'||p_tenant::text,0));
  SELECT * INTO c FROM public.event_funnel_collection WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Funnel group not found' USING ERRCODE='PT404'; END IF;
  IF c.revision <> p_revision THEN RAISE EXCEPTION 'Funnel group changed' USING ERRCODE='PT409'; END IF;
  UPDATE public.event_funnel_event_link SET collection_id=NULL, revision=revision+1, updated_by=p_actor,
    updated_at=clock_timestamp() WHERE tenant_id=p_tenant AND collection_id=p_id;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  DELETE FROM public.event_funnel_collection_member WHERE tenant_id=p_tenant AND collection_id=p_id;
  DELETE FROM public.event_funnel_collection WHERE tenant_id=p_tenant AND id=p_id;
  RETURN jsonb_build_object('deleted', true, 'clearedEventLinks', cleared);
END $$;

-- Put a funnel in a group (or remove it with p_collection NULL).
CREATE FUNCTION public.event_funnel_collection_assign(p_tenant uuid, p_definition uuid, p_collection uuid, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_tenant IS NULL OR p_definition IS NULL OR NOT public.event_funnel_actor_ok(p_actor) THEN
    RAISE EXCEPTION 'Invalid funnel group assignment' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('event-funnel-publish:'||p_tenant::text,0));
  IF NOT EXISTS (SELECT 1 FROM public.event_funnel_definition WHERE tenant_id=p_tenant AND id=p_definition) THEN
    RAISE EXCEPTION 'Definition not found' USING ERRCODE='PT404';
  END IF;
  IF p_collection IS NULL THEN
    DELETE FROM public.event_funnel_collection_member WHERE tenant_id=p_tenant AND definition_id=p_definition;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.event_funnel_collection WHERE tenant_id=p_tenant AND id=p_collection) THEN
      RAISE EXCEPTION 'Funnel group not found' USING ERRCODE='PT404';
    END IF;
    INSERT INTO public.event_funnel_collection_member VALUES (p_tenant, p_definition, p_collection)
      ON CONFLICT (tenant_id, definition_id) DO UPDATE SET collection_id=EXCLUDED.collection_id;
  END IF;
  RETURN jsonb_build_object('definitionId', p_definition, 'collectionId', p_collection);
END $$;

-- Link an event to one funnel, one group, or neither (both NULL).
CREATE FUNCTION public.event_funnel_set_event_link(p_tenant uuid, p_kind text, p_event uuid, p_definition uuid,
  p_collection uuid, p_revision integer, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE l public.event_funnel_event_link;
BEGIN
  IF p_tenant IS NULL OR p_event IS NULL OR p_kind IS NULL OR p_kind NOT IN ('simple','complex')
    OR p_revision IS NULL OR p_revision < 0 OR NOT public.event_funnel_actor_ok(p_actor)
    OR (p_definition IS NOT NULL AND p_collection IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid event funnel link' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('event-funnel-publish:'||p_tenant::text,0));
  IF (p_kind='simple' AND NOT EXISTS(SELECT 1 FROM public.event WHERE tenant_id=p_tenant AND id=p_event))
    OR (p_kind='complex' AND NOT EXISTS(SELECT 1 FROM public.complex_event WHERE tenant_id=p_tenant AND id=p_event)) THEN
    RAISE EXCEPTION 'Event not found' USING ERRCODE='PT404';
  END IF;
  IF p_definition IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.event_funnel_definition WHERE tenant_id=p_tenant AND id=p_definition)
    OR p_collection IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.event_funnel_collection WHERE tenant_id=p_tenant AND id=p_collection) THEN
    RAISE EXCEPTION 'Funnel or group not found' USING ERRCODE='PT404';
  END IF;
  SELECT * INTO l FROM public.event_funnel_event_link WHERE tenant_id=p_tenant AND event_kind=p_kind AND event_id=p_event FOR UPDATE;
  IF coalesce(l.revision, 0) <> p_revision THEN RAISE EXCEPTION 'Event funnel link changed' USING ERRCODE='PT409'; END IF;
  INSERT INTO public.event_funnel_event_link AS x(tenant_id, event_kind, event_id, definition_id, collection_id, updated_by)
    VALUES (p_tenant, p_kind, p_event, p_definition, p_collection, p_actor)
    ON CONFLICT (tenant_id, event_kind, event_id) DO UPDATE SET definition_id=p_definition, collection_id=p_collection,
      revision=x.revision+1, updated_by=p_actor, updated_at=clock_timestamp()
    RETURNING * INTO l;
  RETURN to_jsonb(l);
END $$;

-- True when a definition is a routing candidate for the event.
CREATE FUNCTION public.event_funnel_in_event_scope(p_tenant uuid, p_kind text, p_event uuid, p_definition uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT CASE
    WHEN l.definition_id IS NOT NULL THEN l.definition_id = p_definition
    WHEN l.collection_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.event_funnel_collection_member m
      WHERE m.tenant_id=p_tenant AND m.collection_id=l.collection_id AND m.definition_id=p_definition)
    ELSE true END
  FROM (SELECT NULL::int AS dummy) d
  LEFT JOIN public.event_funnel_event_link l ON l.tenant_id=p_tenant AND l.event_kind=p_kind AND l.event_id=p_event
$$;

-- Same contract as the ticket-routing release, restricted to in-scope funnels.
CREATE OR REPLACE FUNCTION public.event_funnel_resolve_entry(p_tenant uuid,p_event_kind text,p_event_id uuid,p_ticket text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.event_funnel_entry; m public.event_funnel_ticket_entry; enabled boolean; legacy_count integer;
BEGIN
  IF p_event_kind IS NULL OR p_event_kind NOT IN ('simple','complex')
    OR p_tenant IS NULL OR p_event_id IS NULL THEN RAISE EXCEPTION 'Invalid event' USING ERRCODE='22023'; END IF;
  IF (p_event_kind='simple' AND NOT EXISTS(SELECT 1 FROM public.event WHERE tenant_id=p_tenant AND id=p_event_id))
    OR (p_event_kind='complex' AND NOT EXISTS(SELECT 1 FROM public.complex_event WHERE tenant_id=p_tenant AND id=p_event_id)) THEN
    RAISE EXCEPTION 'Event not found' USING ERRCODE='PT404';
  END IF;
  SELECT s.enabled INTO enabled FROM public.event_funnel_event_setting s
    WHERE tenant_id=p_tenant AND event_kind=p_event_kind AND event_id=p_event_id;
  IF enabled IS DISTINCT FROM true THEN RETURN '{"active":false,"outcome":"normal","reason":"disabled"}'; END IF;
  SELECT count(*) INTO legacy_count FROM public.event_funnel_entry x JOIN public.event_funnel_version v
    ON v.tenant_id=x.tenant_id AND v.id=x.version_id WHERE x.tenant_id=p_tenant
    AND x.event_kind=p_event_kind AND x.event_id=p_event_id AND v.graph->>'entryMode' IS DISTINCT FROM 'ticket_single'
    AND public.event_funnel_in_event_scope(p_tenant,p_event_kind,p_event_id,x.definition_id);
  IF legacy_count>1 OR legacy_count=1 AND EXISTS(SELECT 1 FROM public.event_funnel_ticket_entry t
    WHERE tenant_id=p_tenant AND event_kind=p_event_kind AND event_id=p_event_id
      AND public.event_funnel_in_event_scope(p_tenant,p_event_kind,p_event_id,t.definition_id)) THEN
    RAISE EXCEPTION 'Ambiguous registration route' USING ERRCODE='PT409';
  END IF;
  IF legacy_count=1 THEN
    SELECT x.* INTO e FROM public.event_funnel_entry x JOIN public.event_funnel_version v
      ON v.tenant_id=x.tenant_id AND v.id=x.version_id WHERE x.tenant_id=p_tenant
      AND x.event_kind=p_event_kind AND x.event_id=p_event_id AND v.graph->>'entryMode' IS DISTINCT FROM 'ticket_single'
      AND public.event_funnel_in_event_scope(p_tenant,p_event_kind,p_event_id,x.definition_id);
  ELSIF p_ticket IS NULL THEN
    RETURN '{"active":true,"routing":"ticket","selectionMode":"single"}';
  ELSE
    SELECT * INTO m FROM public.event_funnel_ticket_entry t
      WHERE tenant_id=p_tenant AND event_kind=p_event_kind AND event_id=p_event_id AND ticket_id=p_ticket
        AND public.event_funnel_in_event_scope(p_tenant,p_event_kind,p_event_id,t.definition_id);
    IF NOT FOUND THEN
      IF public.event_funnel_readiness()->>'purchasing' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'Event funnel checkout is not activated' USING ERRCODE='PT409';
      END IF;
      RETURN '{"active":false,"outcome":"normal","reason":"no_match"}';
    END IF;
    SELECT * INTO e FROM public.event_funnel_entry WHERE tenant_id=p_tenant AND definition_id=m.definition_id
      AND version_id=m.version_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Publication mapping unavailable' USING ERRCODE='PT409'; END IF;
  END IF;
  IF public.event_funnel_readiness()->>'purchasing' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Event funnel checkout is not activated' USING ERRCODE='PT409';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.event_funnel_definition
    WHERE tenant_id=p_tenant AND id=e.definition_id AND published_version_id=e.version_id) THEN
    RAISE EXCEPTION 'Publication mapping changed' USING ERRCODE='PT409';
  END IF;
  RETURN jsonb_build_object('active',true,'outcome','funnel','routing',
    CASE WHEN legacy_count=1 THEN 'legacy' ELSE 'ticket' END,'versionId',e.version_id,'sourceNodeId',e.source_node_id);
END $$;

REVOKE ALL ON FUNCTION public.event_funnel_actor_ok(text),
  public.event_funnel_collection_save(uuid,uuid,text,integer,text),
  public.event_funnel_collection_delete(uuid,uuid,integer,text),
  public.event_funnel_collection_assign(uuid,uuid,uuid,text),
  public.event_funnel_set_event_link(uuid,text,uuid,uuid,uuid,integer,text),
  public.event_funnel_in_event_scope(uuid,text,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_collection_save(uuid,uuid,text,integer,text),
  public.event_funnel_collection_delete(uuid,uuid,integer,text),
  public.event_funnel_collection_assign(uuid,uuid,uuid,text),
  public.event_funnel_set_event_link(uuid,text,uuid,uuid,uuid,integer,text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
