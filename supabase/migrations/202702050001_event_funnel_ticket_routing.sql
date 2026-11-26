-- Additive ticket-routing release. INSTALL ONLY WITH NEW OWNER APPROVAL.
-- Does not activate purchasing, workers, or any new event.
BEGIN;
CREATE TABLE public.event_funnel_event_setting (
  tenant_id uuid NOT NULL, event_kind text NOT NULL CHECK(event_kind IN ('simple','complex')),
  event_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
  updated_by text NOT NULL, PRIMARY KEY(tenant_id,event_kind,event_id)
);
-- Preserve previously published event-wide behavior, not a blanket opt-in.
INSERT INTO public.event_funnel_event_setting(tenant_id,event_kind,event_id,enabled,updated_by)
  SELECT tenant_id,event_kind,event_id,true,'migration:legacy-publication' FROM public.event_funnel_entry;
ALTER TABLE public.event_funnel_entry DROP CONSTRAINT event_funnel_entry_pkey;
ALTER TABLE public.event_funnel_entry ADD PRIMARY KEY(tenant_id,definition_id);
CREATE INDEX event_funnel_entry_event ON public.event_funnel_entry(tenant_id,event_kind,event_id);
CREATE TABLE public.event_funnel_ticket_entry (
  tenant_id uuid NOT NULL, event_kind text NOT NULL CHECK(event_kind IN ('simple','complex')),
  event_id uuid NOT NULL, ticket_id text NOT NULL,
  definition_id uuid NOT NULL, version_id uuid NOT NULL, source_node_id text NOT NULL,
  PRIMARY KEY(tenant_id,event_kind,event_id,ticket_id),
  FOREIGN KEY(tenant_id,definition_id,version_id)
    REFERENCES public.event_funnel_version(tenant_id,definition_id,id),
  FOREIGN KEY(tenant_id,definition_id) REFERENCES public.event_funnel_entry(tenant_id,definition_id)
);
ALTER TABLE public.event_funnel_session ADD COLUMN source_ticket_id text;
CREATE TABLE public.event_funnel_entry_request (
  tenant_id uuid NOT NULL,id uuid NOT NULL,event_kind text NOT NULL,event_id uuid NOT NULL,
  ticket_id text,member_id uuid,capability_hash text,session_id uuid,outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  CHECK((member_id IS NULL)<>(capability_hash IS NULL))
);
CREATE INDEX event_funnel_entry_request_retention ON public.event_funnel_entry_request(created_at,tenant_id,id);
ALTER TABLE public.event_funnel_event_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_ticket_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_entry_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_event_setting,public.event_funnel_ticket_entry,public.event_funnel_entry_request
  FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY event_funnel_setting_read ON public.event_funnel_event_setting FOR SELECT TO service_role USING(true);
GRANT SELECT ON public.event_funnel_event_setting TO service_role;

CREATE FUNCTION public.event_funnel_set_enabled(p_tenant uuid,p_kind text,p_event uuid,
  p_enabled boolean,p_revision integer,p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE setting public.event_funnel_event_setting; event_row jsonb;
BEGIN
  IF p_enabled IS NULL OR p_revision IS NULL OR p_revision<0 OR length(btrim(p_actor)) NOT BETWEEN 1 AND 150
    OR p_actor IS NULL OR p_kind IS NULL OR p_kind NOT IN ('simple','complex') THEN
    RAISE EXCEPTION 'Invalid event setting' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('event-funnel-publish:'||p_tenant::text,0));
  PERFORM public.event_funnel_lock_event(p_tenant,p_kind,p_event);
  IF (p_kind='simple' AND NOT EXISTS(SELECT 1 FROM public.event WHERE tenant_id=p_tenant AND id=p_event))
    OR (p_kind='complex' AND NOT EXISTS(SELECT 1 FROM public.complex_event WHERE tenant_id=p_tenant AND id=p_event)) THEN
    RAISE EXCEPTION 'Event not found' USING ERRCODE='PT404';
  END IF;
  IF p_kind='simple' THEN SELECT to_jsonb(e) INTO event_row FROM public.event e WHERE tenant_id=p_tenant AND id=p_event;
  ELSE SELECT to_jsonb(e) INTO event_row FROM public.complex_event e WHERE tenant_id=p_tenant AND id=p_event; END IF;
  IF p_enabled AND (event_row->>'waiting_list_enabled'='true'
    OR p_kind='simple' AND (nullif(event_row->>'program_tag','') IS NOT NULL OR event_row->>'is_complex'='true')) THEN
    RAISE EXCEPTION 'This event uses a different registration process' USING ERRCODE='22023';
  END IF;
  SELECT * INTO setting FROM public.event_funnel_event_setting
    WHERE tenant_id=p_tenant AND event_kind=p_kind AND event_id=p_event FOR UPDATE;
  IF coalesce(setting.revision,0)<>p_revision THEN RAISE EXCEPTION 'Event setting changed' USING ERRCODE='PT409'; END IF;
  INSERT INTO public.event_funnel_event_setting AS s VALUES(p_tenant,p_kind,p_event,p_enabled,1,p_actor)
    ON CONFLICT(tenant_id,event_kind,event_id) DO UPDATE
      SET enabled=p_enabled,revision=s.revision+1,updated_by=p_actor RETURNING * INTO setting;
  RETURN to_jsonb(setting);
END $$;

-- Retain the installed commercial/version/offer-policy routine verbatim except
-- its obsolete event-wide collision check. Refuse unexpected prerequisites.
ALTER FUNCTION public.event_funnel_publish(uuid,uuid,integer,text,jsonb) RENAME TO event_funnel_publish_unmapped;
DO $patch$
DECLARE original text; patched text;
BEGIN
  original:=pg_get_functiondef('public.event_funnel_publish_unmapped(uuid,uuid,integer,text,jsonb)'::regprocedure);
  patched:=replace(original,$old$
  IF EXISTS(SELECT 1 FROM public.event_funnel_entry WHERE tenant_id=p_tenant
    AND event_kind=source#>>'{event,kind}' AND event_id=(source#>>'{event,id}')::uuid AND definition_id<>d.id) THEN
    RAISE EXCEPTION 'Another published funnel owns this source' USING ERRCODE='PT409';
  END IF;
$old$,'');
  IF original=patched THEN RAISE EXCEPTION 'Unexpected funnel publication prerequisite'; END IF;
  EXECUTE patched;
END $patch$;
CREATE FUNCTION public.event_funnel_publish(
  p_tenant uuid,p_definition uuid,p_expected_revision integer,p_actor text,p_commercial jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.event_funnel_definition; source jsonb; conflict_ticket text; result jsonb; label text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('event-funnel-publish:'||p_tenant::text,0));
  SELECT * INTO d FROM public.event_funnel_definition WHERE tenant_id=p_tenant AND id=p_definition FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Definition not found' USING ERRCODE='PT404'; END IF;
  IF d.revision<>p_expected_revision THEN RAISE EXCEPTION 'Definition changed' USING ERRCODE='PT409'; END IF;
  SELECT value INTO source FROM jsonb_array_elements(d.graph->'nodes') WHERE value->>'id'=d.graph->>'entry';
  IF d.graph ? 'entryMode' AND (d.graph->>'entryMode'<>'ticket_single' OR source->>'selectionMode' IS DISTINCT FROM 'single') THEN
    RAISE EXCEPTION 'Ticket routing requires a single-choice source' USING ERRCODE='22023';
  END IF;
  SELECT t INTO conflict_ticket FROM jsonb_array_elements_text(source->'ticketIds') t
    WHERE EXISTS(SELECT 1 FROM public.event_funnel_entry e JOIN public.event_funnel_version v
      ON v.tenant_id=e.tenant_id AND v.id=e.version_id
      WHERE e.tenant_id=p_tenant AND e.event_kind=source#>>'{event,kind}'
        AND e.event_id=(source#>>'{event,id}')::uuid AND e.definition_id<>d.id
        AND (d.graph->>'entryMode' IS DISTINCT FROM 'ticket_single'
          OR v.graph->>'entryMode' IS DISTINCT FROM 'ticket_single'
          OR EXISTS(SELECT 1 FROM public.event_funnel_ticket_entry m
            WHERE m.tenant_id=e.tenant_id AND m.definition_id=e.definition_id AND m.ticket_id=t)))
    ORDER BY t LIMIT 1;
  IF conflict_ticket IS NOT NULL THEN
    IF source#>>'{event,kind}'='simple' THEN
      SELECT ticket->>'name' INTO label FROM public.event e,
        LATERAL jsonb_array_elements(public.event_funnel_simple_tickets(to_jsonb(e))) ticket
        WHERE e.tenant_id=p_tenant AND e.id=(source#>>'{event,id}')::uuid AND ticket->>'id'=conflict_ticket;
    ELSE
      SELECT to_jsonb(t)->>'name' INTO label FROM public.complex_event_ticket_class t
        WHERE t.tenant_id=p_tenant AND t.complex_event_id=(source#>>'{event,id}')::uuid AND t.id::text=conflict_ticket;
    END IF;
    RAISE EXCEPTION 'Another published funnel already routes ticket "%".',coalesce(label,conflict_ticket) USING ERRCODE='PT409';
  END IF;
  -- Delete before the base replaces its entry; the whole operation rolls back
  -- together on a price, revision, capacity or uniqueness failure.
  DELETE FROM public.event_funnel_ticket_entry WHERE tenant_id=p_tenant AND definition_id=d.id;
  result:=public.event_funnel_publish_unmapped(p_tenant,p_definition,p_expected_revision,p_actor,p_commercial);
  IF d.graph->>'entryMode'='ticket_single' THEN
    INSERT INTO public.event_funnel_ticket_entry
      SELECT p_tenant,source#>>'{event,kind}',(source#>>'{event,id}')::uuid,t,d.id,
        (result->>'versionId')::uuid,source->>'id' FROM jsonb_array_elements_text(source->'ticketIds') t;
  END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.event_funnel_resolve_entry(p_tenant uuid,p_event_kind text,p_event_id uuid,p_ticket text DEFAULT NULL)
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
    AND x.event_kind=p_event_kind AND x.event_id=p_event_id AND v.graph->>'entryMode' IS DISTINCT FROM 'ticket_single';
  IF legacy_count>1 OR legacy_count=1 AND EXISTS(SELECT 1 FROM public.event_funnel_ticket_entry
    WHERE tenant_id=p_tenant AND event_kind=p_event_kind AND event_id=p_event_id) THEN
    RAISE EXCEPTION 'Ambiguous registration route' USING ERRCODE='PT409';
  END IF;
  IF legacy_count=1 THEN
    SELECT x.* INTO e FROM public.event_funnel_entry x JOIN public.event_funnel_version v
      ON v.tenant_id=x.tenant_id AND v.id=x.version_id WHERE x.tenant_id=p_tenant
      AND x.event_kind=p_event_kind AND x.event_id=p_event_id AND v.graph->>'entryMode' IS DISTINCT FROM 'ticket_single';
  ELSIF p_ticket IS NULL THEN
    -- Discovery exposes no arbitrarily chosen funnel or filtered source list.
    RETURN '{"active":true,"routing":"ticket","selectionMode":"single"}';
  ELSE
    SELECT * INTO m FROM public.event_funnel_ticket_entry
      WHERE tenant_id=p_tenant AND event_kind=p_event_kind AND event_id=p_event_id AND ticket_id=p_ticket;
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

-- Old application releases must not select an arbitrary event-wide entry.
CREATE OR REPLACE FUNCTION public.event_funnel_find_entry(p_tenant uuid,p_event_kind text,p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  result:=public.event_funnel_resolve_entry(p_tenant,p_event_kind,p_event_id,NULL);
  IF result->>'routing'='ticket' THEN RAISE EXCEPTION 'Ticket-aware application required' USING ERRCODE='PT409'; END IF;
  RETURN result;
END $$;

ALTER FUNCTION public.event_funnel_create_session(uuid,uuid,uuid,uuid,text) RENAME TO event_funnel_create_session_unrouted;
CREATE FUNCTION public.event_funnel_start_routed(p_tenant uuid,p_id uuid,p_kind text,p_event uuid,p_ticket text,
  p_member uuid,p_capability_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; prior public.event_funnel_entry_request; g jsonb;
BEGIN
  IF (p_member IS NULL)=(p_capability_hash IS NULL) OR p_id IS NULL THEN
    RAISE EXCEPTION 'Verified purchaser required' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('event-funnel-publish:'||p_tenant::text,0));
  SELECT * INTO prior FROM public.event_funnel_entry_request WHERE tenant_id=p_tenant AND id=p_id;
  IF FOUND THEN
    IF ROW(prior.event_kind,prior.event_id,prior.ticket_id,prior.member_id,prior.capability_hash)
      IS DISTINCT FROM ROW(p_kind,p_event,p_ticket,p_member,p_capability_hash) THEN
      RAISE EXCEPTION 'Registration request changed' USING ERRCODE='PT409';
    END IF;
    RETURN prior.outcome;
  END IF;
  result:=public.event_funnel_resolve_entry(p_tenant,p_kind,p_event,p_ticket);
  IF result->>'routing'='ticket' AND p_ticket IS NULL THEN
    RAISE EXCEPTION 'Choose one ticket class' USING ERRCODE='22023'; END IF;
  IF result->>'active'='true' THEN
    PERFORM public.event_funnel_create_session_unrouted(p_tenant,p_id,(result->>'versionId')::uuid,p_member,p_capability_hash);
    IF result->>'routing'='ticket' THEN
      UPDATE public.event_funnel_session SET source_ticket_id=p_ticket WHERE tenant_id=p_tenant AND id=p_id;
    END IF;
    result:=result||jsonb_build_object('sessionId',p_id);
  END IF;
  INSERT INTO public.event_funnel_entry_request VALUES(p_tenant,p_id,p_kind,p_event,p_ticket,p_member,p_capability_hash,
    CASE WHEN result->>'active'='true' THEN p_id ELSE NULL END,result);
  RETURN result;
END $$;
-- Keep the old signature only for legacy versions; no bypass for ticket mode.
CREATE FUNCTION public.event_funnel_create_session(p_tenant uuid,p_id uuid,p_version uuid,p_member uuid,p_capability_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.event_funnel_version WHERE tenant_id=p_tenant AND id=p_version AND graph ? 'entryMode') THEN
    RAISE EXCEPTION 'Ticket-aware registration required' USING ERRCODE='PT409'; END IF;
  RETURN public.event_funnel_create_session_unrouted(p_tenant,p_id,p_version,p_member,p_capability_hash);
END $$;

CREATE FUNCTION public.event_funnel_single_choice_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n jsonb; bound text;
BEGIN
  SELECT node,s.source_ticket_id INTO n,bound FROM public.event_funnel_session s
    JOIN public.event_funnel_version v ON v.tenant_id=s.tenant_id AND v.id=s.version_id,
    LATERAL jsonb_array_elements(v.graph->'nodes') node
    WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.session_id AND node->>'id'=NEW.node_id;
  IF n->>'selectionMode'='single' AND EXISTS(SELECT 1 FROM public.event_funnel_hold
    WHERE tenant_id=NEW.tenant_id AND session_id=NEW.session_id AND node_id=NEW.node_id AND ticket_id<>NEW.ticket_id) THEN
    RAISE EXCEPTION 'Choose one ticket class for this step' USING ERRCODE='22023';
  END IF;
  IF n->>'type'='source' AND bound IS NOT NULL AND bound<>NEW.ticket_id THEN
    RAISE EXCEPTION 'Initial ticket requires a new route' USING ERRCODE='PT409'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_single_choice_guard BEFORE INSERT OR UPDATE ON public.event_funnel_hold
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_single_choice_guard();
CREATE FUNCTION public.event_funnel_source_binding_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.source_ticket_id IS NOT NULL AND NEW.source_ticket_id IS DISTINCT FROM OLD.source_ticket_id THEN
    RAISE EXCEPTION 'Initial ticket binding is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_source_binding_immutable BEFORE UPDATE ON public.event_funnel_session
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_source_binding_immutable();

CREATE FUNCTION public.event_funnel_switch_source(p_tenant uuid,p_old uuid,p_member uuid,p_old_capability text,
  p_revision integer,p_id uuid,p_capability text,p_kind text,p_event uuid,p_ticket text,
  p_version uuid,p_lines jsonb,p_answers jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old public.event_funnel_session; result jsonb; candidate jsonb; r record; source jsonb; graph jsonb;
  prior public.event_funnel_entry_request;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('event-funnel-publish:'||p_tenant::text,0));
  old:=public.event_funnel_owned_session(p_tenant,p_old,p_member,p_old_capability);
  SELECT * INTO prior FROM public.event_funnel_entry_request WHERE tenant_id=p_tenant AND id=p_id;
  IF FOUND THEN
    IF prior.member_id IS DISTINCT FROM p_member OR prior.capability_hash IS DISTINCT FROM p_capability
      OR prior.outcome->>'replaces' IS DISTINCT FROM p_old::text
      OR prior.ticket_id IS DISTINCT FROM p_ticket OR prior.event_kind<>p_kind OR prior.event_id<>p_event THEN
      RAISE EXCEPTION 'Restart request changed' USING ERRCODE='PT409'; END IF;
    RETURN prior.outcome;
  END IF;
  IF old.revision<>p_revision OR old.state NOT IN ('draft','held') OR old.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Reservation changed or expired' USING ERRCODE='PT409'; END IF;
  SELECT v.graph INTO graph FROM public.event_funnel_version v WHERE tenant_id=p_tenant AND id=old.version_id;
  SELECT n INTO source FROM jsonb_array_elements(graph->'nodes') n WHERE n->>'id'=graph->>'entry';
  IF old.source_ticket_id IS NULL OR source#>>'{event,kind}'<>p_kind OR source#>>'{event,id}'<>p_event::text THEN
    RAISE EXCEPTION 'Not a ticket-routed source' USING ERRCODE='PT409'; END IF;
  candidate:=public.event_funnel_resolve_entry(p_tenant,p_kind,p_event,p_ticket);
  IF nullif(candidate->>'versionId','')::uuid IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'Ticket routing changed; retry' USING ERRCODE='PT409'; END IF;
  -- Lock the union before releasing anything. Failure rolls the complete
  -- transition back, including old downstream stock and the old revision.
  FOR r IN
    SELECT event_kind,event_id FROM public.event_funnel_hold WHERE tenant_id=p_tenant AND session_id=p_old
    UNION SELECT p_kind,p_event ORDER BY 1,2
  LOOP PERFORM public.event_funnel_lock_event(p_tenant,r.event_kind,r.event_id); END LOOP;
  result:=public.event_funnel_start_routed(p_tenant,p_id,p_kind,p_event,p_ticket,p_member,p_capability);
  DELETE FROM public.event_funnel_hold WHERE tenant_id=p_tenant AND session_id=p_old;
  UPDATE public.event_funnel_session SET state='cancelled',revision=revision+1 WHERE tenant_id=p_tenant AND id=p_old;
  IF result->>'active'='true' THEN
    IF old.first_reserved_at IS NOT NULL THEN
      UPDATE public.event_funnel_session SET state='held',first_reserved_at=old.first_reserved_at,expires_at=old.expires_at
        WHERE tenant_id=p_tenant AND id=p_id;
    END IF;
    PERFORM public.event_funnel_apply_journey(p_tenant,p_id,p_member,p_capability,1,p_lines,
      '{"version":1,"decisions":{},"checkoutNow":false}',result->>'sourceNodeId',p_answers);
  END IF;
  result:=result||jsonb_build_object('replaces',p_old,'expiresAt',old.expires_at);
  UPDATE public.event_funnel_entry_request SET outcome=result WHERE tenant_id=p_tenant AND id=p_id;
  RETURN result;
END $$;

CREATE FUNCTION public.event_funnel_replay_source_switch(p_tenant uuid,p_id uuid,p_old uuid,p_member uuid,p_capability text,
  p_kind text,p_event uuid,p_ticket text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior public.event_funnel_entry_request;
BEGIN
  SELECT * INTO prior FROM public.event_funnel_entry_request WHERE tenant_id=p_tenant AND id=p_id;
  IF NOT FOUND THEN RETURN '{"found":false}'; END IF;
  IF prior.member_id IS DISTINCT FROM p_member OR prior.capability_hash IS DISTINCT FROM p_capability
    OR prior.outcome->>'replaces' IS DISTINCT FROM p_old::text OR prior.ticket_id IS DISTINCT FROM p_ticket
    OR prior.event_kind<>p_kind OR prior.event_id<>p_event THEN
    RAISE EXCEPTION 'Restart request changed' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('found',true,'outcome',prior.outcome);
END $$;

-- All existing standalone preparation guards already lock the event row and
-- preserve exact immutable replays. New purchases cannot skip required routing.
CREATE OR REPLACE FUNCTION public.event_funnel_standalone_offer_allowed(p_tenant uuid,p_kind text,p_event uuid,p_tickets jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; ticket text;
BEGIN
  IF p_tenant IS NULL OR p_event IS NULL OR p_kind IS NULL OR p_kind NOT IN ('simple','complex')
    OR jsonb_typeof(p_tickets) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tickets)>100
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_tickets) t WHERE jsonb_typeof(t)<>'string'
      OR length(t#>>'{}') NOT BETWEEN 1 AND 160) THEN
    RAISE EXCEPTION 'Invalid event offer check' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM public.event_funnel_offer_policy p
    JOIN public.event_funnel_entry x ON x.tenant_id=p.tenant_id AND x.version_id=p.version_id
    WHERE p.tenant_id=p_tenant AND p.event_kind=p_kind AND p.event_id=p_event AND p.funnel_only
      AND (jsonb_array_length(p_tickets)=0
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_tickets) t WHERE p.ticket_ids ? t))) THEN RETURN false; END IF;
  result:=public.event_funnel_resolve_entry(p_tenant,p_kind,p_event,NULL);
  IF result->>'routing'='ticket' AND (SELECT count(DISTINCT t) FROM jsonb_array_elements_text(p_tickets) t)<>1 THEN
    RETURN false;
  END IF;
  FOR ticket IN SELECT jsonb_array_elements_text(p_tickets) LOOP
    result:=public.event_funnel_resolve_entry(p_tenant,p_kind,p_event,ticket);
    IF result->>'active'='true' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION public.event_funnel_choice_contract_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.graph ? 'entryMode' AND NEW.graph->>'entryMode' IS DISTINCT FROM 'ticket_single'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.graph->'nodes') n
      WHERE n ? 'selectionMode' AND n->>'selectionMode' NOT IN ('single','multiple'))
    OR NEW.graph->>'entryMode'='ticket_single' AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(NEW.graph->'nodes') n WHERE n->>'id'=NEW.graph->>'entry'
        AND n->>'type'='source' AND n->>'selectionMode'='single') THEN
    RAISE EXCEPTION 'Invalid persisted ticket-choice contract' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_choice_contract_guard BEFORE INSERT OR UPDATE ON public.event_funnel_definition
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_choice_contract_guard();

ALTER FUNCTION public.event_funnel_maintenance() RENAME TO event_funnel_maintenance_before_ticket_routing;
CREATE FUNCTION public.event_funnel_maintenance()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; removed integer;
BEGIN
  result:=public.event_funnel_maintenance_before_ticket_routing();
  WITH old AS (SELECT tenant_id,id FROM public.event_funnel_entry_request
    WHERE created_at<clock_timestamp()-interval '7 days' ORDER BY created_at,tenant_id,id
    LIMIT 100 FOR UPDATE SKIP LOCKED)
  DELETE FROM public.event_funnel_entry_request r USING old
    WHERE r.tenant_id=old.tenant_id AND r.id=old.id;
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN result||jsonb_build_object('entryRequestsPruned',removed);
END $$;

REVOKE ALL ON FUNCTION public.event_funnel_publish_unmapped(uuid,uuid,integer,text,jsonb),
  public.event_funnel_maintenance_before_ticket_routing(),public.event_funnel_maintenance(),
  public.event_funnel_create_session_unrouted(uuid,uuid,uuid,uuid,text),
  public.event_funnel_set_enabled(uuid,text,uuid,boolean,integer,text),
  public.event_funnel_publish(uuid,uuid,integer,text,jsonb),
  public.event_funnel_resolve_entry(uuid,text,uuid,text),
  public.event_funnel_start_routed(uuid,uuid,text,uuid,text,uuid,text),
  public.event_funnel_single_choice_guard(),public.event_funnel_source_binding_immutable(),public.event_funnel_choice_contract_guard(),
  public.event_funnel_switch_source(uuid,uuid,uuid,text,integer,uuid,text,text,uuid,text,uuid,jsonb,jsonb),
  public.event_funnel_replay_source_switch(uuid,uuid,uuid,uuid,text,text,uuid,text),
  public.event_funnel_create_session(uuid,uuid,uuid,uuid,text),
  public.event_funnel_standalone_offer_allowed(uuid,text,uuid,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_set_enabled(uuid,text,uuid,boolean,integer,text),
  public.event_funnel_maintenance(),
  public.event_funnel_publish(uuid,uuid,integer,text,jsonb),public.event_funnel_resolve_entry(uuid,text,uuid,text),
  public.event_funnel_start_routed(uuid,uuid,text,uuid,text,uuid,text),
  public.event_funnel_switch_source(uuid,uuid,uuid,text,integer,uuid,text,text,uuid,text,uuid,jsonb,jsonb),
  public.event_funnel_replay_source_switch(uuid,uuid,uuid,uuid,text,text,uuid,text),
  public.event_funnel_create_session(uuid,uuid,uuid,uuid,text),
  public.event_funnel_standalone_offer_allowed(uuid,text,uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
