-- Draft route decisions, answers and stock changes share one revision/commit.
-- Does not enable publishing, session creation or payment.
BEGIN;
ALTER TABLE public.event_funnel_session ADD COLUMN journey jsonb NOT NULL
  DEFAULT '{"version":1,"decisions":{},"checkoutNow":false}'::jsonb
  CHECK (jsonb_typeof(journey)='object' AND octet_length(journey::text)<=32768);

CREATE FUNCTION public.event_funnel_frozen_journey()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.state NOT IN ('draft','held','expired') AND NEW.journey IS DISTINCT FROM OLD.journey THEN
    RAISE EXCEPTION 'Payable route is frozen' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_frozen_journey BEFORE UPDATE OF journey ON public.event_funnel_session
FOR EACH ROW EXECUTE FUNCTION public.event_funnel_frozen_journey();

-- Removing an optional selection must still work if that event has since been
-- deleted. Lock extant rows; purchase callers separately require a real event
-- and ticket before adding/re-reserving. A missing row owns no reusable stock.
CREATE OR REPLACE FUNCTION public.event_funnel_lock_event(p_tenant uuid,p_kind text,p_event uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_kind='simple' THEN
    PERFORM 1 FROM public.event WHERE tenant_id=p_tenant AND id=p_event FOR UPDATE;
  ELSIF p_kind='complex' THEN
    PERFORM 1 FROM public.complex_event WHERE tenant_id=p_tenant AND id=p_event FOR UPDATE;
  ELSE RAISE EXCEPTION 'Invalid event kind' USING ERRCODE='22023';
  END IF;
END $$;

-- A live reservation keeps its group multiplier and price snapshot. An admin
-- reducing capacity must not prevent removing an optional item or maintaining
-- the already reserved source; only an increase past the baseline is rejected.
DO $patch$
DECLARE original text; patched text;
BEGIN
  original:=pg_get_functiondef('public.event_funnel_replace_holds(uuid,uuid,uuid,text,integer,jsonb,boolean)'::regprocedure);
  patched:=replace(original,'source_found boolean:=false;',
    'source_found boolean:=false; old_holds jsonb; old_hold jsonb; baseline jsonb:=''{}''; baseline_key text;');
  IF patched=original THEN RAISE EXCEPTION 'Unexpected hold declaration contract'; END IF;
  original:=patched;
  patched:=replace(patched,'  IF s.first_reserved_at IS NULL OR s.state=''expired'' THEN',$insert$
  -- Snapshot before changing state: expired holds must not count as their own
  -- baseline when re-reserving, and must not retain old prices/multipliers.
  IF s.state='held' AND s.expires_at>now_at THEN
    SELECT coalesce(jsonb_agg(to_jsonb(h)),'[]') INTO old_holds FROM public.event_funnel_hold h
      WHERE h.tenant_id=p_tenant AND h.session_id=p_id;
  ELSE old_holds:='[]'; END IF;
  FOR r IN
    SELECT DISTINCT n#>>'{event,kind}' AS kind,(n#>>'{event,id}')::uuid AS eid,l->>'ticketId' AS ticket
    FROM jsonb_array_elements(p_lines) l JOIN jsonb_array_elements(g->'nodes') n ON n->>'id'=l->>'nodeId'
    WHERE n->>'type' IN ('source','event','addon') ORDER BY kind,eid,ticket
  LOOP
    state:=public.sales_capacity_state(r.kind,r.eid,r.ticket);
    baseline_key:=jsonb_build_array(r.kind,r.eid,r.ticket)::text;
    baseline:=baseline||jsonb_build_object(baseline_key,coalesce((state->>'used')::bigint,0));
    baseline_key:=jsonb_build_array(r.kind,r.eid)::text;
    IF r.kind='simple' THEN
      SELECT to_jsonb(x) INTO e FROM public.event x WHERE x.id=r.eid;
      IF e->>'capacity_mode'='total' THEN
        state:=public.simple_event_capacity(r.eid);
        baseline:=baseline||jsonb_build_object(baseline_key,(state->>'used')::bigint);
      END IF;
    END IF;
  END LOOP;
  IF s.first_reserved_at IS NULL OR s.state='expired' THEN$insert$);
  IF patched=original THEN RAISE EXCEPTION 'Unexpected hold baseline contract'; END IF;
  original:=patched;
  patched:=replace(patched,'    IF multiplier IS NULL OR multiplier NOT BETWEEN 1 AND 10000 OR qty::bigint*multiplier>100000 THEN',$insert$
    SELECT h INTO old_hold FROM jsonb_array_elements(old_holds) h
      WHERE h->>'node_id'=node->>'id' AND h->>'ticket_id'=line->>'ticketId';
    IF old_hold IS NOT NULL THEN
      multiplier:=(old_hold->>'places')::integer/(old_hold->>'quantity')::integer;
      line:=jsonb_set(line,'{priceSnapshot}',old_hold->'price_snapshot');
    END IF;
    IF multiplier IS NULL OR multiplier NOT BETWEEN 1 AND 10000 OR qty::bigint*multiplier>100000 THEN$insert$);
  IF patched=original THEN RAISE EXCEPTION 'Unexpected hold multiplier contract'; END IF;
  original:=patched;
  patched:=replace(patched,$old$
    IF (state->>'unlimited')::boolean IS DISTINCT FROM true AND (state->>'ok')::boolean IS DISTINCT FROM true THEN
$old$,$new$
    IF (state->>'unlimited')::boolean IS DISTINCT FROM true AND (state->>'ok')::boolean IS DISTINCT FROM true
      AND (state->>'used')::bigint>coalesce((baseline->>jsonb_build_array(r.event_kind,r.event_id,r.ticket_id)::text)::bigint,0) THEN
$new$);
  IF patched=original THEN RAISE EXCEPTION 'Unexpected held ticket baseline check'; END IF;
  original:=patched;
  patched:=replace(patched,$old$
      IF state->>'total' IS NOT NULL AND (state->>'used')::bigint>(state->>'total')::bigint THEN
$old$,$new$
      IF state->>'total' IS NOT NULL AND (state->>'used')::bigint>(state->>'total')::bigint
        AND (state->>'used')::bigint>coalesce((baseline->>jsonb_build_array(r.event_kind,r.event_id)::text)::bigint,0) THEN
$new$);
  IF patched=original THEN RAISE EXCEPTION 'Unexpected held event baseline check'; END IF;
  EXECUTE patched;
END $patch$;

CREATE FUNCTION public.event_funnel_apply_journey(
  p_tenant uuid,p_id uuid,p_member uuid,p_capability_hash text,p_expected_revision integer,
  p_lines jsonb,p_journey jsonb,p_answer_node text DEFAULT NULL,p_answers jsonb DEFAULT NULL,
  p_rereserve boolean DEFAULT false,p_answer_updates jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_session; g jsonb; decision record; node jsonb; r record;
BEGIN
  s:=public.event_funnel_owned_session(p_tenant,p_id,p_member,p_capability_hash);
  IF s.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Journey changed' USING ERRCODE='PT409'; END IF;
  IF s.state NOT IN ('draft','held','expired') THEN RAISE EXCEPTION 'Checkout is frozen' USING ERRCODE='PT409'; END IF;
  IF p_journey IS NULL OR jsonb_typeof(p_journey) IS DISTINCT FROM 'object'
    OR p_journey->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(p_journey->'decisions') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_journey->'checkoutNow') IS DISTINCT FROM 'boolean'
    OR octet_length(p_journey::text)>32768
    OR p_journey-ARRAY['version','decisions','checkoutNow']<>'{}'::jsonb
    OR p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid journey decisions' USING ERRCODE='22023';
  END IF;
  SELECT graph INTO g FROM public.event_funnel_version WHERE tenant_id=p_tenant AND id=s.version_id;
  FOR decision IN SELECT * FROM jsonb_each(p_journey->'decisions') LOOP
    SELECT n INTO node FROM jsonb_array_elements(g->'nodes') n WHERE n->>'id'=decision.key;
    IF node IS NULL OR node->>'type' NOT IN ('event','addon') OR decision.value IS DISTINCT FROM '"skip"'::jsonb
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE l->>'nodeId'=decision.key) THEN
      RAISE EXCEPTION 'Invalid skipped offer' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (p_journey->>'checkoutNow')::boolean AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE l->>'nodeId' IS DISTINCT FROM g->>'entry'
  ) THEN RAISE EXCEPTION 'Source-only checkout cannot contain optional purchases' USING ERRCODE='22023'; END IF;
  IF p_answer_node IS NULL AND p_answers IS NOT NULL THEN RAISE EXCEPTION 'Invalid answer target' USING ERRCODE='22023'; END IF;
  IF p_answer_node IS NOT NULL THEN
    IF p_answers IS NULL OR jsonb_typeof(p_answers) IS DISTINCT FROM 'object' OR octet_length(p_answers::text)>65536
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE l->>'nodeId'=p_answer_node) THEN
      RAISE EXCEPTION 'Invalid draft answers' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.event_funnel_draft(tenant_id,session_id,node_id,answers) VALUES(p_tenant,p_id,p_answer_node,p_answers)
    ON CONFLICT (tenant_id,session_id,node_id) DO UPDATE SET answers=EXCLUDED.answers,updated_at=clock_timestamp();
  END IF;
  IF p_answer_updates IS NULL OR jsonb_typeof(p_answer_updates) IS DISTINCT FROM 'object'
    OR octet_length(p_answer_updates::text)>262144 THEN
    RAISE EXCEPTION 'Invalid answer updates' USING ERRCODE='22023';
  END IF;
  FOR decision IN SELECT * FROM jsonb_each(p_answer_updates) LOOP
    IF jsonb_typeof(decision.value) IS DISTINCT FROM 'object' OR octet_length(decision.value::text)>65536
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE l->>'nodeId'=decision.key) THEN
      RAISE EXCEPTION 'Invalid answer update target' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.event_funnel_draft(tenant_id,session_id,node_id,answers) VALUES(p_tenant,p_id,decision.key,decision.value)
    ON CONFLICT (tenant_id,session_id,node_id) DO UPDATE SET answers=EXCLUDED.answers,updated_at=clock_timestamp();
  END LOOP;
  -- Expired drafts may discard optional items without acquiring stock, resetting
  -- the clock or forcing an unavailable optional offer to be re-reserved first.
  IF p_rereserve IS DISTINCT FROM true AND (s.state='expired' OR s.expires_at<=clock_timestamp()) THEN
    IF jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 OR octet_length(p_lines::text)>262144
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE l->>'nodeId'=g->>'entry')
      OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(p_lines) l LEFT JOIN public.event_funnel_hold h
          ON h.tenant_id=p_tenant AND h.session_id=p_id AND h.node_id=l->>'nodeId' AND h.ticket_id=l->>'ticketId'
        WHERE h.session_id IS NULL OR jsonb_typeof(l->'quantity') IS DISTINCT FROM 'number'
          OR (l->>'quantity')::numeric<>h.quantity
      ) OR (SELECT count(*) FROM jsonb_array_elements(p_lines)) <>
        (SELECT count(DISTINCT jsonb_build_array(l->>'nodeId',l->>'ticketId')) FROM jsonb_array_elements(p_lines) l) THEN
      RAISE EXCEPTION 'Re-reservation required to add or change expired tickets' USING ERRCODE='PT409';
    END IF;
    FOR r IN SELECT DISTINCT event_kind,event_id FROM public.event_funnel_hold
      WHERE tenant_id=p_tenant AND session_id=p_id ORDER BY event_kind,event_id LOOP
      PERFORM public.event_funnel_lock_event(p_tenant,r.event_kind,r.event_id);
    END LOOP;
    DELETE FROM public.event_funnel_hold h WHERE h.tenant_id=p_tenant AND h.session_id=p_id
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE l->>'nodeId'=h.node_id AND l->>'ticketId'=h.ticket_id);
    UPDATE public.event_funnel_session SET state='expired',journey=p_journey,revision=revision+1,updated_at=clock_timestamp()
      WHERE tenant_id=p_tenant AND id=p_id;
    RETURN public.event_funnel_read_session(p_tenant,p_id,p_member,p_capability_hash);
  END IF;
  -- Internal call increments the revision exactly once. If capacity fails,
  -- answers and decisions roll back along with every inventory mutation.
  PERFORM public.event_funnel_replace_holds(p_tenant,p_id,p_member,p_capability_hash,p_expected_revision,p_lines,p_rereserve);
  UPDATE public.event_funnel_session SET journey=p_journey WHERE tenant_id=p_tenant AND id=p_id;
  RETURN public.event_funnel_read_session(p_tenant,p_id,p_member,p_capability_hash);
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_frozen_journey(),
  public.event_funnel_apply_journey(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,boolean,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE EXECUTE ON FUNCTION public.event_funnel_replace_holds(uuid,uuid,uuid,text,integer,jsonb,boolean) FROM service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_apply_journey(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,boolean,jsonb) TO service_role;
COMMIT;
