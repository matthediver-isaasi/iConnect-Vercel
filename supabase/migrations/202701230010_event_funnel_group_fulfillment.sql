BEGIN;
CREATE TABLE public.event_funnel_group_booking (
  tenant_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  group_booking_id uuid NOT NULL REFERENCES public.event_group_booking(id),
  booking_source text NOT NULL DEFAULT 'booking' CHECK(booking_source='booking'),
  PRIMARY KEY(tenant_id,booking_id),
  UNIQUE(group_booking_id),
  FOREIGN KEY(tenant_id,booking_source,booking_id)
    REFERENCES public.event_funnel_order_booking(tenant_id,booking_source,booking_id)
);
ALTER TABLE public.event_funnel_group_booking ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_group_booking FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.event_funnel_create_group(p_tenant uuid,p_order uuid,p_booking uuid,p_size integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order; b public.booking; allocation public.event_funnel_order_booking; group_id uuid;
BEGIN
  SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order;
  SELECT * INTO allocation FROM public.event_funnel_order_booking
    WHERE tenant_id=p_tenant AND order_id=p_order AND booking_source='booking' AND booking_id=p_booking;
  SELECT * INTO b FROM public.booking WHERE tenant_id=p_tenant AND id=p_booking;
  IF o.id IS NULL OR b.id IS NULL OR allocation.booking_id IS NULL OR p_size<2 OR allocation.places IS DISTINCT FROM p_size THEN
    RAISE EXCEPTION 'Invalid group entitlement' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.event_group_booking(tenant_id,event_id,ticket_class_id,booker_email,booker_first_name,booker_last_name,
    token,status,group_size,booking_reference,payment_method,total_cost)
    VALUES(p_tenant,b.event_id,b.ticket_class_id,lower(o.snapshot->'purchaser'->>'email'),
      o.snapshot->'purchaser'->>'first_name',o.snapshot->'purchaser'->>'last_name',
      replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),
      'active',p_size,b.booking_reference,b.payment_method,allocation.gross_minor/100.0)
    RETURNING id INTO group_id;
  INSERT INTO public.event_funnel_group_booking(tenant_id,booking_id,group_booking_id) VALUES(p_tenant,p_booking,group_id);
END $$;

CREATE FUNCTION public.event_funnel_group_extra_places(p_tenant uuid,p_event uuid,p_ticket text DEFAULT NULL)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce(sum(l.places-1),0)::bigint FROM public.event_funnel_order_booking l
    JOIN public.booking b ON b.id=l.booking_id AND b.tenant_id=l.tenant_id
    WHERE l.tenant_id=p_tenant AND l.booking_source='booking' AND l.event_id=p_event
      AND (p_ticket IS NULL OR l.ticket_id=p_ticket) AND l.places>1 AND b.status='confirmed'
$$;
-- The leader's existing registration already counts once. Add only the other
-- purchased places; naming participants never consumes inventory again.
DO $patch$
DECLARE original text; patched text; routine text;
BEGIN
  original:=pg_get_functiondef('public.sales_capacity_state(text,uuid,text)'::regprocedure);
  IF position('v_used:=v_confirmed+v_unused+v_shopping;' IN original)=0 THEN
    RAISE EXCEPTION 'Unexpected shared ticket inventory prerequisite';
  END IF;
  patched:=replace(original,'v_used:=v_confirmed+v_unused+v_shopping;',
    'IF p_event_kind=''simple'' THEN v_confirmed:=v_confirmed+public.event_funnel_group_extra_places(v_tenant_id,p_event_id,p_ticket_type_id); END IF; v_used:=v_confirmed+v_unused+v_shopping;');
  EXECUTE patched;
  original:=pg_get_functiondef('public.simple_event_capacity(uuid)'::regprocedure);
  IF position('shopping:=public.event_funnel_held_places' IN original)=0 THEN
    RAISE EXCEPTION 'Unexpected shared event inventory prerequisite';
  END IF;
  patched:=replace(original,'shopping:=public.event_funnel_held_places',
    'confirmed:=confirmed+public.event_funnel_group_extra_places(e.tenant_id,e.id); shopping:=public.event_funnel_held_places');
  EXECUTE patched;
  FOREACH routine IN ARRAY ARRAY['public.check_oneoff_ticket_capacity(uuid,text,integer,uuid[])'] LOOP
    original:=pg_get_functiondef(routine::regprocedure);
    IF position('count(*)+(s->>''commercialUnused'')::integer' IN original)=0 THEN
      RAISE EXCEPTION 'Unexpected ordinary group inventory prerequisite: %',routine;
    END IF;
    patched:=replace(original,'count(*)+(s->>''commercialUnused'')::integer',
      'count(*)+public.event_funnel_group_extra_places((SELECT tenant_id FROM public.event WHERE id=p_event_id),p_event_id,p_ticket_class_id)+(s->>''commercialUnused'')::integer');
    EXECUTE patched;
  END LOOP;
END $patch$;

CREATE FUNCTION public.event_funnel_group_identity_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE linked public.event_funnel_group_booking; current_status text;
BEGIN
  SELECT * INTO linked FROM public.event_funnel_group_booking WHERE group_booking_id=OLD.id;
  IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Purchased group entitlement must be retained' USING ERRCODE='PT409'; END IF;
  IF (NEW.tenant_id,NEW.event_id,NEW.ticket_class_id,NEW.group_size,NEW.token,NEW.booking_reference,NEW.booker_email)
    IS DISTINCT FROM (OLD.tenant_id,OLD.event_id,OLD.ticket_class_id,OLD.group_size,OLD.token,OLD.booking_reference,OLD.booker_email) THEN
    RAISE EXCEPTION 'Purchased group entitlement is immutable' USING ERRCODE='PT409';
  END IF;
  SELECT status INTO current_status FROM public.booking WHERE tenant_id=linked.tenant_id AND id=linked.booking_id;
  IF NEW.status='active' AND current_status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'Cancelled registration cannot activate a group' USING ERRCODE='PT409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_group_identity BEFORE UPDATE OR DELETE ON public.event_group_booking
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_group_identity_guard();

CREATE FUNCTION public.event_funnel_group_parent_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE group_id uuid;
BEGIN
  SELECT group_booking_id INTO group_id FROM public.event_funnel_group_booking WHERE tenant_id=OLD.tenant_id AND booking_id=OLD.id;
  IF group_id IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.event_id,NEW.ticket_class_id) IS DISTINCT FROM (OLD.tenant_id,OLD.event_id,OLD.ticket_class_id) THEN
    RAISE EXCEPTION 'Group transfers require allocation-aware handling' USING ERRCODE='PT409';
  END IF;
  IF TG_OP='DELETE' OR NEW.status IS DISTINCT FROM 'confirmed' THEN
    UPDATE public.event_group_booking SET status='cancelled' WHERE id=group_id;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER event_funnel_group_parent AFTER UPDATE OR DELETE ON public.booking
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_group_parent_guard();
CREATE FUNCTION public.event_funnel_group_participant_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g public.event_group_booking; used bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.event_funnel_group_booking WHERE group_booking_id=NEW.group_booking_id) THEN RETURN NEW; END IF;
  SELECT * INTO g FROM public.event_group_booking WHERE id=NEW.group_booking_id FOR UPDATE;
  IF g.tenant_id IS DISTINCT FROM NEW.tenant_id OR g.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Group is unavailable' USING ERRCODE='PT409';
  END IF;
  SELECT count(*) INTO used FROM public.event_group_booking_participant
    WHERE group_booking_id=g.id AND id IS DISTINCT FROM NEW.id;
  IF used>=g.group_size THEN RAISE EXCEPTION 'Group is full' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_group_participant BEFORE INSERT OR UPDATE ON public.event_group_booking_participant
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_group_participant_guard();
CREATE OR REPLACE FUNCTION public.event_funnel_groups_ready() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.event_funnel_group_extra_places(uuid,uuid,text),
  public.event_funnel_group_identity_guard(),public.event_funnel_group_parent_guard(),public.event_funnel_group_participant_guard()
  FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
