-- Staged inventory authority; does not enable purchasing.
BEGIN;
CREATE TABLE public.event_funnel_hold (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  node_id text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('simple','complex')),
  event_id uuid NOT NULL,
  ticket_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  places integer NOT NULL CHECK (places BETWEEN 1 AND 100000),
  price_snapshot jsonb NOT NULL CHECK (jsonb_typeof(price_snapshot)='object'),
  PRIMARY KEY (tenant_id,session_id,node_id,ticket_id),
  UNIQUE (tenant_id,session_id,event_kind,event_id,ticket_id),
  FOREIGN KEY (tenant_id,session_id) REFERENCES public.event_funnel_session(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX event_funnel_hold_inventory ON public.event_funnel_hold(tenant_id,event_kind,event_id,ticket_id);
ALTER TABLE public.event_funnel_hold ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_hold FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.event_funnel_held_places(
  p_tenant uuid,p_kind text,p_event uuid,p_ticket text DEFAULT NULL,p_exclude_session uuid DEFAULT NULL
) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce(sum(h.places),0)::bigint
  FROM public.event_funnel_hold h JOIN public.event_funnel_session s
    ON s.tenant_id=h.tenant_id AND s.id=h.session_id
  WHERE h.tenant_id=p_tenant AND h.event_kind=p_kind AND h.event_id=p_event
    AND (p_ticket IS NULL OR h.ticket_id=p_ticket)
    AND (p_exclude_session IS NULL OR h.session_id<>p_exclude_session)
    AND (s.state IN ('payable','confirming','payment_uncertain')
      OR (s.state='held' AND s.expires_at>clock_timestamp()))
$$;

CREATE FUNCTION public.event_funnel_lock_event(p_tenant uuid,p_kind text,p_event uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_kind='simple' THEN
    PERFORM 1 FROM public.event WHERE tenant_id=p_tenant AND id=p_event FOR UPDATE;
  ELSIF p_kind='complex' THEN
    PERFORM 1 FROM public.complex_event WHERE tenant_id=p_tenant AND id=p_event FOR UPDATE;
  ELSE RAISE EXCEPTION 'Invalid event kind' USING ERRCODE='22023';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found' USING ERRCODE='22023'; END IF;
END $$;

-- Existing booking and allocation writers participate even when the first hold
-- is being created concurrently. Testing only for pre-existing holds would race.
CREATE FUNCTION public.event_funnel_writer_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE kind text; eid uuid; tid uuid; class_id text; old_kind text; old_eid uuid; old_tid uuid; r record;
BEGIN
  IF TG_TABLE_NAME='sales_commercial_allocation_movement' THEN
    SELECT a.event_reference_kind,a.event_id,a.tenant_id,a.ticket_type_id INTO kind,eid,tid,class_id
      FROM public.sales_commercial_allocation a WHERE a.id=NEW.allocation_id AND a.tenant_id=NEW.tenant_id;
  ELSE
    kind:=CASE WHEN TG_TABLE_NAME='booking' THEN 'simple' ELSE 'complex' END;
    eid:=NEW.event_id;tid:=NEW.tenant_id;class_id:=NEW.ticket_class_id;
    IF TG_OP='UPDATE' THEN old_kind:=kind;old_eid:=OLD.event_id;old_tid:=OLD.tenant_id; END IF;
  END IF;
  FOR r IN SELECT DISTINCT k,e,t FROM (VALUES(kind,eid,tid),(old_kind,old_eid,old_tid)) v(k,e,t)
    WHERE e IS NOT NULL AND t IS NOT NULL ORDER BY k,e,t LOOP
    -- Historical detached rows remain maintainable.
    IF r.k='simple' THEN PERFORM 1 FROM public.event WHERE id=r.e AND tenant_id=r.t FOR UPDATE;
    ELSE PERFORM 1 FROM public.complex_event WHERE id=r.e AND tenant_id=r.t FOR UPDATE;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER a_event_funnel_writer_lock BEFORE INSERT OR UPDATE ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.event_funnel_writer_lock();
CREATE TRIGGER a_event_funnel_writer_lock BEFORE INSERT OR UPDATE ON public.complex_event_booking
FOR EACH ROW EXECUTE FUNCTION public.event_funnel_writer_lock();
CREATE TRIGGER a_event_funnel_writer_lock BEFORE INSERT ON public.sales_commercial_allocation_movement
FOR EACH ROW EXECUTE FUNCTION public.event_funnel_writer_lock();

-- Preserve the actual installed capacity routines and their OIDs. Refuse an
-- unexpected prerequisite rather than replace historical semantics blindly.
DO $patch$
DECLARE original text; patched text; routine text;
BEGIN
  original:=pg_get_functiondef('public.sales_capacity_state(text,uuid,text)'::regprocedure);
  IF position('DECLARE v_tenant_id uuid;' IN original)=0 OR position('v_used:=v_confirmed+v_unused;' IN original)=0
    OR position('''commercialUnused'',v_unused' IN original)=0 THEN
    RAISE EXCEPTION 'Unexpected ticket capacity prerequisite';
  END IF;
  patched:=replace(original,'DECLARE v_tenant_id uuid;','DECLARE v_tenant_id uuid; v_shopping bigint;');
  patched:=replace(patched,'  PERFORM pg_advisory_xact_lock',$inject$
  IF p_event_kind='complex' THEN PERFORM 1 FROM public.complex_event WHERE id=p_event_id FOR UPDATE; END IF;
  PERFORM pg_advisory_xact_lock$inject$);
  patched:=replace(patched,'v_used:=v_confirmed+v_unused;',
    'v_shopping:=public.event_funnel_held_places(v_tenant_id,p_event_kind,p_event_id,p_ticket_type_id); v_used:=v_confirmed+v_unused+v_shopping;');
  patched:=replace(patched,'''commercialUnused'',v_unused','''shoppingHeld'',v_shopping,''commercialUnused'',v_unused');
  EXECUTE patched;
  FOREACH routine IN ARRAY ARRAY['public.check_oneoff_ticket_capacity(uuid,text,integer,uuid[])',
    'public.check_complex_event_ticket_capacity(uuid,text,integer,uuid[])'] LOOP
    original:=pg_get_functiondef(routine::regprocedure);
    patched:=replace(original,'count(*)+(s->>''commercialUnused'')::integer',
      'count(*)+(s->>''commercialUnused'')::integer+coalesce((s->>''shoppingHeld'')::integer,0)');
    IF patched=original THEN RAISE EXCEPTION 'Unexpected post-insert capacity prerequisite: %',routine; END IF;
    EXECUTE patched;
  END LOOP;
  original:=pg_get_functiondef('public.simple_event_capacity(uuid)'::regprocedure);
  IF position('DECLARE e public.event; confirmed bigint; unused bigint;' IN original)=0
    OR position('''used'',confirmed+unused' IN original)=0 THEN
    RAISE EXCEPTION 'Unexpected simple total capacity prerequisite';
  END IF;
  patched:=replace(original,'DECLARE e public.event; confirmed bigint; unused bigint;',
    'DECLARE e public.event; confirmed bigint; unused bigint; shopping bigint;');
  patched:=replace(patched,'  RETURN jsonb_build_object(''total''',
    '  shopping:=public.event_funnel_held_places(e.tenant_id,''simple'',e.id); RETURN jsonb_build_object(''total''');
  patched:=replace(patched,'''used'',confirmed+unused','''used'',confirmed+unused+shopping');
  patched:=replace(patched,'e.total_capacity-confirmed-unused','e.total_capacity-confirmed-unused-shopping');
  patched:=replace(patched,' END);',' END) || CASE WHEN shopping>0 THEN jsonb_build_object(''shopping_held'',shopping) ELSE ''{}''::jsonb END;');
  EXECUTE patched;
END $patch$;

-- Commercial baskets used to lock simple event rows first and complex ticket
-- locks later. Match the hold writer's complete event ordering before either.
DO $locks$
DECLARE fn record; original text; patched text; prefix text;
BEGIN
  FOR fn IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'move_sales_commercial_allocation','reconcile_sales_commercial_booking',
      'unreconcile_sales_commercial_booking','cancel_event_booking_with_allocation',
      'reserve_sales_allocation_invitation','claim_sales_allocation_invitation',
      'release_sales_allocation_invitation') LOOP
    original:=pg_get_functiondef(fn.oid);
    prefix:=substring(original FROM 'PERFORM capacity_event[.]id FROM public[.]event capacity_event[^;]+;');
    IF prefix IS NULL THEN RAISE EXCEPTION 'Unexpected commercial entry point lock prerequisite'; END IF;
    patched:=replace(prefix,'public.event capacity_event','public.complex_event capacity_event');
    patched:=replace(patched,'public.booking capacity_booking','public.complex_event_booking capacity_booking');
    patched:=replace(patched,'''simple''','''complex''');
    EXECUTE replace(original,prefix,patched||E'\n  '||prefix);
  END LOOP;
  FOR fn IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('confirm_sales_quote_sale','confirm_sales_quote_ticket_sale')
      AND position('pg_temp.sale_candidates' IN p.prosrc)>0 LOOP
    original:=pg_get_functiondef(fn.oid);
    patched:=replace(original,$old$
  PERFORM e.id FROM public.event e WHERE e.id IN
    (SELECT c.event_id FROM pg_temp.sale_candidates c WHERE c.event_reference_kind='simple')
    ORDER BY e.id FOR UPDATE;
$old$,$new$
  FOR candidate IN SELECT DISTINCT event_reference_kind,event_id FROM pg_temp.sale_candidates
    ORDER BY event_reference_kind,event_id LOOP
    PERFORM public.event_funnel_lock_event(p_tenant_id,candidate.event_reference_kind,candidate.event_id);
  END LOOP;
$new$);
    IF patched=original THEN RAISE EXCEPTION 'Unexpected commercial basket event locking prerequisite'; END IF;
    EXECUTE patched;
  END LOOP;
END $locks$;

-- Legacy event counters remain counters. Holds do not decrement or reconstruct
-- them; this guard protects the residual counter whenever an existing writer
-- spends seats. Counter restoration and total-mode behavior remain unchanged.
CREATE FUNCTION public.event_funnel_counter_is_finite(p_kind text,p_event jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT p_event->>'available_seats' IS NOT NULL AND CASE
    WHEN p_kind='complex' THEN (p_event->>'available_seats')::bigint<>0
    WHEN p_event ? 'is_unlimited_registration' THEN p_event->>'is_unlimited_registration' IS DISTINCT FROM 'true'
    ELSE (p_event->>'available_seats')::bigint<>0 END
$$;

CREATE FUNCTION public.event_funnel_counter_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE held bigint; kind text;
BEGIN
  IF TG_TABLE_NAME='event' AND to_jsonb(NEW)->>'capacity_mode'='total' THEN RETURN NEW; END IF;
  IF NEW.available_seats IS NOT NULL AND OLD.available_seats IS NOT NULL
    AND NEW.available_seats<OLD.available_seats THEN
    kind:=CASE WHEN TG_TABLE_NAME='event' THEN 'simple' ELSE 'complex' END;
    held:=public.event_funnel_held_places(NEW.tenant_id,kind,NEW.id);
    IF held>0 AND NEW.available_seats<held
      AND public.event_funnel_counter_is_finite(kind,to_jsonb(OLD)) THEN
      RAISE EXCEPTION 'Event places are reserved by another checkout' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_counter_guard BEFORE UPDATE OF available_seats ON public.event
FOR EACH ROW EXECUTE FUNCTION public.event_funnel_counter_guard();
CREATE TRIGGER event_funnel_counter_guard BEFORE UPDATE OF available_seats ON public.complex_event
FOR EACH ROW EXECUTE FUNCTION public.event_funnel_counter_guard();

-- Deferred checks cover direct inserts and commercial movements which bypass
-- the preflight RPCs. Commercial naming/release and booking insertion can still
-- share a transaction without transiently counting a place twice.
CREATE FUNCTION public.event_funnel_verify_writer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE kind text; eid uuid; tid uuid; ticket text; state jsonb; held bigint;
BEGIN
  IF TG_TABLE_NAME='sales_commercial_allocation_movement' THEN
    SELECT a.event_reference_kind,a.event_id,a.tenant_id,a.ticket_type_id INTO kind,eid,tid,ticket
      FROM public.sales_commercial_allocation a WHERE a.id=NEW.allocation_id AND a.tenant_id=NEW.tenant_id;
  ELSE
    IF NEW.status IS DISTINCT FROM 'confirmed' THEN RETURN NULL; END IF;
    kind:=CASE WHEN TG_TABLE_NAME='booking' THEN 'simple' ELSE 'complex' END;
    eid:=NEW.event_id;tid:=NEW.tenant_id;ticket:=NEW.ticket_class_id;
  END IF;
  held:=public.event_funnel_held_places(tid,kind,eid,ticket);
  IF held=0 OR ticket IS NULL THEN RETURN NULL; END IF;
  state:=public.sales_capacity_state(kind,eid,ticket);
  IF (state->>'unlimited')::boolean IS DISTINCT FROM true AND (state->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Ticket places are reserved by another checkout' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER event_funnel_verify_writer AFTER INSERT OR UPDATE ON public.booking
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.event_funnel_verify_writer();
CREATE CONSTRAINT TRIGGER event_funnel_verify_writer AFTER INSERT OR UPDATE ON public.complex_event_booking
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.event_funnel_verify_writer();
CREATE CONSTRAINT TRIGGER event_funnel_verify_writer AFTER INSERT ON public.sales_commercial_allocation_movement
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.event_funnel_verify_writer();

-- Called only after the server has evaluated the frozen graph, eligibility and
-- prices. p_lines replaces the complete reachable selection, never a client-
-- chosen next node. Identity and revision checks are repeated under the lock.
CREATE FUNCTION public.event_funnel_replace_holds(
  p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text,p_expected_revision integer,
  p_lines jsonb,p_rereserve boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_session; g jsonb; line jsonb; node jsonb; e jsonb; ticket jsonb;
  r record; qty integer; multiplier integer; held bigint; state jsonb; duration integer;
  now_at timestamptz; source_found boolean:=false;
BEGIN
  s:=public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
  IF s.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Journey changed' USING ERRCODE='PT409'; END IF;
  IF s.state NOT IN ('draft','held','expired') THEN RAISE EXCEPTION 'Checkout is frozen' USING ERRCODE='PT409'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR octet_length(p_lines::text)>262144 THEN
    RAISE EXCEPTION 'Invalid selections' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid selection count' USING ERRCODE='22023'; END IF;
  SELECT graph INTO g FROM public.event_funnel_version WHERE tenant_id=p_tenant AND id=s.version_id;
  duration:=(g->>'reservationSeconds')::integer;
  IF duration IS NULL OR duration NOT BETWEEN 60 AND 3600 THEN RAISE EXCEPTION 'Invalid reservation duration'; END IF;
  -- Acquire the union of old and new event locks in a deterministic order before
  -- any ticket advisory lock or hold mutation.
  FOR r IN
    SELECT event_kind,event_id FROM public.event_funnel_hold WHERE tenant_id=p_tenant AND session_id=p_id
    UNION
    SELECT n#>>'{event,kind}',(n#>>'{event,id}')::uuid FROM jsonb_array_elements(g->'nodes') n
      WHERE n->>'id' IN (SELECT value->>'nodeId' FROM jsonb_array_elements(p_lines))
        AND n->>'type' IN ('source','event','addon')
    ORDER BY 1,2
  LOOP PERFORM public.event_funnel_lock_event(p_tenant,r.event_kind,r.event_id); END LOOP;
  now_at:=clock_timestamp();
  IF s.expires_at IS NOT NULL AND (s.expires_at<=now_at OR s.state='expired') THEN
    IF p_rereserve IS DISTINCT FROM true THEN RAISE EXCEPTION 'Reservation expired; re-reserve and review prices' USING ERRCODE='PT409'; END IF;
    UPDATE public.event_funnel_session SET state='expired' WHERE id=p_id;
    s.state:='expired';
  ELSIF p_rereserve THEN
    RAISE EXCEPTION 'A live reservation cannot be extended' USING ERRCODE='PT409';
  END IF;
  IF s.first_reserved_at IS NULL OR s.state='expired' THEN
    UPDATE public.event_funnel_session SET state='held',first_reserved_at=now_at,
      expires_at=now_at+make_interval(secs=>duration) WHERE id=p_id RETURNING * INTO s;
  END IF;
  DELETE FROM public.event_funnel_hold WHERE tenant_id=p_tenant AND session_id=p_id;
  FOR line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT n INTO node FROM jsonb_array_elements(g->'nodes') n WHERE n->>'id'=line->>'nodeId';
    IF node IS NULL OR node->>'type' NOT IN ('source','event','addon')
      OR NOT (node->'ticketIds' ? (line->>'ticketId'))
      OR jsonb_typeof(line->'quantity') IS DISTINCT FROM 'number'
      OR jsonb_typeof(line->'priceSnapshot') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid purchase selection' USING ERRCODE='22023';
    END IF;
    IF (line->>'quantity')::numeric<>trunc((line->>'quantity')::numeric) THEN
      RAISE EXCEPTION 'Whole ticket quantities required' USING ERRCODE='22023';
    END IF;
    qty:=(line->>'quantity')::integer;
    IF qty NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid quantity' USING ERRCODE='22023'; END IF;
    IF node->>'type'='source' THEN source_found:=true; END IF;
    IF node#>>'{event,kind}'='simple' THEN
      SELECT to_jsonb(x) INTO e FROM public.event x WHERE x.id=(node#>>'{event,id}')::uuid AND x.tenant_id=p_tenant;
      SELECT t INTO ticket FROM jsonb_array_elements(public.event_funnel_simple_tickets(e)) t WHERE t->>'id'=line->>'ticketId';
    ELSE
      SELECT to_jsonb(x) INTO e FROM public.complex_event x WHERE x.id=(node#>>'{event,id}')::uuid AND x.tenant_id=p_tenant;
      SELECT to_jsonb(t) INTO ticket FROM public.complex_event_ticket_class t
        WHERE t.complex_event_id=(node#>>'{event,id}')::uuid AND t.tenant_id=p_tenant AND t.id::text=line->>'ticketId';
    END IF;
    IF e IS NULL OR ticket IS NULL THEN RAISE EXCEPTION 'Event or ticket no longer exists' USING ERRCODE='22023'; END IF;
    multiplier:=CASE WHEN coalesce((ticket->>'is_group_ticket')::boolean,false)
      THEN (ticket->>'group_size')::integer ELSE 1 END;
    IF multiplier IS NULL OR multiplier NOT BETWEEN 1 AND 10000 OR qty::bigint*multiplier>100000 THEN
      RAISE EXCEPTION 'Invalid group size' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.event_funnel_hold VALUES(p_tenant,p_id,node->>'id',node#>>'{event,kind}',
      (node#>>'{event,id}')::uuid,line->>'ticketId',qty,qty*multiplier,line->'priceSnapshot');
  END LOOP;
  IF NOT source_found THEN RAISE EXCEPTION 'Source selection is required' USING ERRCODE='22023'; END IF;
  -- Check the final complete set; any failure rolls back deletion, insertion,
  -- revision and timer together, preserving all previously held source stock.
  FOR r IN SELECT DISTINCT event_kind,event_id,ticket_id FROM public.event_funnel_hold
    WHERE tenant_id=p_tenant AND session_id=p_id ORDER BY event_kind,event_id,ticket_id LOOP
    state:=public.sales_capacity_state(r.event_kind,r.event_id,r.ticket_id);
    IF (state->>'unlimited')::boolean IS DISTINCT FROM true AND (state->>'ok')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Ticket capacity unavailable' USING ERRCODE='23514';
    END IF;
    IF r.event_kind='simple' THEN SELECT to_jsonb(x) INTO e FROM public.event x WHERE x.id=r.event_id;
    ELSE SELECT to_jsonb(x) INTO e FROM public.complex_event x WHERE x.id=r.event_id; END IF;
    IF r.event_kind='simple' AND e->>'capacity_mode'='total' THEN
      state:=public.simple_event_capacity(r.event_id);
      IF state->>'total' IS NOT NULL AND (state->>'used')::bigint>(state->>'total')::bigint THEN
        RAISE EXCEPTION 'Event capacity unavailable' USING ERRCODE='23514';
      END IF;
    ELSIF public.event_funnel_counter_is_finite(r.event_kind,e) THEN
      held:=public.event_funnel_held_places(p_tenant,r.event_kind,r.event_id);
      IF held>(e->>'available_seats')::bigint THEN RAISE EXCEPTION 'Event capacity unavailable' USING ERRCODE='23514'; END IF;
    END IF;
  END LOOP;
  UPDATE public.event_funnel_session SET state='held',revision=revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND id=p_id RETURNING * INTO s;
  RETURN jsonb_build_object('session',to_jsonb(s)-'guest_capability_hash','serverNow',clock_timestamp(),
    'holds',(SELECT jsonb_agg(to_jsonb(h)-'tenant_id'-'session_id') FROM public.event_funnel_hold h WHERE tenant_id=p_tenant AND session_id=p_id));
END $$;

CREATE FUNCTION public.event_funnel_expire_holds()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s record; r record; n integer:=0;
BEGIN
  FOR s IN SELECT id,tenant_id FROM public.event_funnel_session WHERE state='held' AND expires_at<=clock_timestamp()
    ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
    FOR r IN SELECT DISTINCT event_kind,event_id FROM public.event_funnel_hold WHERE tenant_id=s.tenant_id AND session_id=s.id
      ORDER BY event_kind,event_id LOOP PERFORM public.event_funnel_lock_event(s.tenant_id,r.event_kind,r.event_id); END LOOP;
    UPDATE public.event_funnel_session SET state='expired',revision=revision+1,updated_at=clock_timestamp() WHERE id=s.id;
    n:=n+1;
  END LOOP;
  RETURN n;
END $$;

CREATE FUNCTION public.event_funnel_inventory_projection(p_tenant uuid,p_kind text,p_events uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF p_tenant IS NULL OR p_kind NOT IN ('simple','complex') OR p_kind IS NULL
    OR p_events IS NULL OR cardinality(p_events) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid inventory scope' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM (
    SELECT h.event_id,h.ticket_id,sum(h.places)::bigint AS places
    FROM public.event_funnel_hold h JOIN public.event_funnel_session s
      ON s.tenant_id=h.tenant_id AND s.id=h.session_id
    WHERE h.tenant_id=p_tenant AND h.event_kind=p_kind AND h.event_id=ANY(p_events)
      AND (s.state IN ('payable','confirming','payment_uncertain') OR (s.state='held' AND s.expires_at>clock_timestamp()))
    GROUP BY h.event_id,h.ticket_id ORDER BY h.event_id,h.ticket_id
  ) x;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.event_funnel_read_session(
  p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_session; drafts jsonb; graph jsonb; holds jsonb;
BEGIN
  s:=public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
  SELECT v.graph INTO graph FROM public.event_funnel_version v WHERE v.tenant_id=p_tenant AND v.id=s.version_id;
  SELECT coalesce(jsonb_object_agg(d.node_id,d.answers),'{}') INTO drafts FROM public.event_funnel_draft d
    WHERE d.tenant_id=p_tenant AND d.session_id=p_id;
  SELECT coalesce(jsonb_agg(to_jsonb(h)-'tenant_id'-'session_id' ORDER BY h.node_id,h.ticket_id),'[]') INTO holds
    FROM public.event_funnel_hold h WHERE h.tenant_id=p_tenant AND h.session_id=p_id;
  RETURN jsonb_build_object('session',to_jsonb(s)-'guest_capability_hash','graph',graph,'drafts',drafts,
    'holds',holds,'serverNow',clock_timestamp());
END $$;

REVOKE ALL ON FUNCTION public.event_funnel_held_places(uuid,text,uuid,text,uuid),public.event_funnel_lock_event(uuid,text,uuid),
  public.event_funnel_counter_is_finite(text,jsonb),
  public.event_funnel_writer_lock(),public.event_funnel_counter_guard(),public.event_funnel_verify_writer(),
  public.event_funnel_replace_holds(uuid,uuid,uuid,text,integer,jsonb,boolean),public.event_funnel_expire_holds(),
  public.event_funnel_inventory_projection(uuid,text,uuid[])
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_replace_holds(uuid,uuid,uuid,text,integer,jsonb,boolean),
  public.event_funnel_expire_holds(),public.event_funnel_inventory_projection(uuid,text,uuid[]) TO service_role;
COMMIT;
