BEGIN;
-- Preserve existing zero/unlimited semantics. Legacy available_seats remains a
-- counter, not a reconstructed maximum. Unnamed sales places reserve part of
-- that counter without decrementing it until an ordinary booking is created.
CREATE FUNCTION public.sales_guard_legacy_event_capacity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE kind text; eid uuid; tid uuid; e jsonb; finite boolean; unused bigint; shopping bigint;
BEGIN
  IF TG_TABLE_NAME='sales_commercial_allocation_movement' THEN
    SELECT event_reference_kind,event_id,tenant_id INTO kind,eid,tid
      FROM public.sales_commercial_allocation WHERE id=NEW.allocation_id AND tenant_id=NEW.tenant_id;
  ELSE
    kind:=CASE WHEN TG_TABLE_NAME='event' THEN 'simple' ELSE 'complex' END;
    eid:=NEW.id;tid:=NEW.tenant_id;
  END IF;
  IF kind='simple' THEN SELECT to_jsonb(x) INTO e FROM public.event x WHERE id=eid AND tenant_id=tid FOR UPDATE;
  ELSE SELECT to_jsonb(x) INTO e FROM public.complex_event x WHERE id=eid AND tenant_id=tid FOR UPDATE;
  END IF;
  IF e IS NULL OR (kind='simple' AND e->>'capacity_mode'='total') THEN RETURN NULL; END IF;
  finite:=public.event_funnel_counter_is_finite(kind,e);
  IF TG_TABLE_NAME<>'sales_commercial_allocation_movement' THEN
    finite:=finite OR public.event_funnel_counter_is_finite(kind,to_jsonb(OLD));
  END IF;
  IF NOT finite THEN RETURN NULL; END IF;
  SELECT coalesce(sum(greatest(remaining-named,0)),0) INTO unused
    FROM public.sales_commercial_allocation_totals
    WHERE tenant_id=tid AND event_reference_kind=kind AND event_id=eid;
  shopping:=public.event_funnel_held_places(tid,kind,eid);
  IF (e->>'available_seats')::bigint<unused+shopping THEN
    RAISE EXCEPTION 'Whole-event places are reserved or unavailable; reduce the ticket quantity' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER sales_guard_legacy_event_capacity AFTER INSERT ON public.sales_commercial_allocation_movement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.movement_kind IN ('allocated','unnamed'))
  EXECUTE FUNCTION public.sales_guard_legacy_event_capacity();
CREATE CONSTRAINT TRIGGER sales_guard_legacy_event_capacity AFTER UPDATE ON public.event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.available_seats<OLD.available_seats)
  EXECUTE FUNCTION public.sales_guard_legacy_event_capacity();
CREATE CONSTRAINT TRIGGER sales_guard_legacy_event_capacity AFTER UPDATE ON public.complex_event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.available_seats<OLD.available_seats)
  EXECUTE FUNCTION public.sales_guard_legacy_event_capacity();
REVOKE ALL ON FUNCTION public.sales_guard_legacy_event_capacity() FROM PUBLIC,anon,authenticated,service_role;
-- Ordinary invitation pages used separate counter updates before/after their
-- claim. Keep the existing claim for transactional credit/total-mode batches,
-- and expose one atomic entry point for callers which do not own that counter.
CREATE FUNCTION public.claim_sales_allocation_invitation_with_event_seat(
  p_token_hash text,p_booking_kind text,p_booking_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE a public.sales_commercial_allocation; e jsonb; previously_claimed timestamptz; result jsonb; consumed boolean:=false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  SELECT allocation.* INTO a FROM public.sales_commercial_allocation allocation
    JOIN public.sales_commercial_allocation_invitation i ON i.tenant_id=allocation.tenant_id AND i.allocation_id=allocation.id
    WHERE i.token_hash=decode(p_token_hash,'hex');
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found' USING ERRCODE='P0002'; END IF;
  IF a.event_reference_kind='simple' THEN
    SELECT to_jsonb(x) INTO e FROM public.event x WHERE tenant_id=a.tenant_id AND id=a.event_id FOR UPDATE;
  ELSE
    SELECT to_jsonb(x) INTO e FROM public.complex_event x WHERE tenant_id=a.tenant_id AND id=a.event_id FOR UPDATE;
  END IF;
  SELECT claimed_at INTO previously_claimed FROM public.sales_commercial_allocation_invitation
    WHERE token_hash=decode(p_token_hash,'hex') FOR UPDATE;
  result:=public.claim_sales_allocation_invitation(p_token_hash,p_booking_kind,p_booking_id);
  IF previously_claimed IS NULL AND NOT (a.event_reference_kind='simple' AND COALESCE(e->>'capacity_mode','')='total')
    AND public.event_funnel_counter_is_finite(a.event_reference_kind,e) THEN
    IF a.event_reference_kind='simple' THEN
      UPDATE public.event SET available_seats=available_seats-1 WHERE tenant_id=a.tenant_id AND id=a.event_id;
    ELSE
      UPDATE public.complex_event SET available_seats=available_seats-1 WHERE tenant_id=a.tenant_id AND id=a.event_id;
    END IF;
    consumed:=true;
  END IF;
  RETURN result||jsonb_build_object('eventSeatConsumed',consumed);
END $fn$;
REVOKE ALL ON FUNCTION public.claim_sales_allocation_invitation_with_event_seat(text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sales_allocation_invitation_with_event_seat(text,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
