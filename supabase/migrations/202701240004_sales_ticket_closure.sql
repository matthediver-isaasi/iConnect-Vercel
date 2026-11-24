BEGIN;
ALTER TABLE public.complex_event_ticket_class ADD COLUMN close_at timestamptz, ADD COLUMN close_timezone text;
ALTER TABLE public.complex_event_ticket_class ADD CONSTRAINT ticket_close_pair CHECK (
  (close_at IS NULL AND close_timezone IS NULL) OR
  (close_at IS NOT NULL AND isfinite(close_at) AND close_timezone IS NOT NULL
    AND length(close_timezone)>0 AND (release_at IS NULL OR close_at>release_at)));

CREATE FUNCTION public.sales_assert_ticket_open(p_tenant uuid,p_kind text,p_event uuid,p_ticket text,p_future boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE e jsonb; t jsonb; close_at timestamptz; event_close timestamptz; starts timestamptz;
BEGIN
  IF p_kind='simple' THEN
    SELECT to_jsonb(x) INTO e FROM public.event x WHERE tenant_id=p_tenant AND id=p_event FOR SHARE;
    SELECT x INTO t FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e#>'{pricing_config,ticket_classes}')='array'
      THEN e#>'{pricing_config,ticket_classes}' ELSE '[]'::jsonb END) x WHERE x->>'id'=p_ticket;
  ELSIF p_kind='complex' THEN
    SELECT to_jsonb(x) INTO e FROM public.complex_event x WHERE tenant_id=p_tenant AND id=p_event FOR SHARE;
    SELECT to_jsonb(x) INTO t FROM public.complex_event_ticket_class x
      WHERE tenant_id=p_tenant AND complex_event_id=p_event AND id::text=p_ticket FOR SHARE;
  ELSE RAISE EXCEPTION 'Invalid ticket event kind' USING ERRCODE='22023';
  END IF;
  IF e IS NULL THEN RAISE EXCEPTION 'Ticket event is unavailable' USING ERRCODE='22023'; END IF;
  IF p_ticket IS NOT NULL AND t IS NULL THEN RAISE EXCEPTION 'Ticket type is unavailable; amend the proposal' USING ERRCODE='22023'; END IF;
  IF e->>'event_state'='closed' OR (NULLIF(e->>'event_state','') IS NULL AND e->>'status'='closed')
    OR e->>'status'='cancelling' THEN
    RAISE EXCEPTION 'This event is closed or being cancelled; amend the proposal' USING ERRCODE='22023';
  END IF;
  IF (e->>'waiting_list_enabled')::boolean IS TRUE THEN
    RAISE EXCEPTION 'This event is in waiting-list mode; choose another event' USING ERRCODE='22023';
  END IF;
  starts:=public.sales_ticket_known_instant(e->>'start_date');
  IF p_future AND (starts IS NULL OR starts<=clock_timestamp()) THEN
    RAISE EXCEPTION 'This event must have a future start instant; amend the proposal' USING ERRCODE='22023';
  END IF;
  close_at:=public.sales_ticket_known_instant(t->>'close_at');
  event_close:=public.sales_ticket_known_instant(e->>'registration_closes_at');
  IF (t->>'close_at' IS NOT NULL AND close_at IS NULL)
    OR (close_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=t->>'close_timezone'))
    OR (close_at IS NOT NULL AND close_at<=public.sales_ticket_known_instant(t->>'release_at'))
    OR (e->>'registration_closes_at' IS NOT NULL AND event_close IS NULL)
    OR (t->>'close_timezone' IS NOT NULL AND close_at IS NULL)
    OR close_at<=clock_timestamp() OR event_close<=clock_timestamp() THEN
    RAISE EXCEPTION 'Registration and amendments are closed for this ticket' USING ERRCODE='22023';
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.sales_assert_ticket_open(uuid,text,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_assert_ticket_open(uuid,text,uuid,text,boolean) TO service_role;

CREATE FUNCTION public.sales_guard_ticket_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE a public.sales_commercial_allocation%ROWTYPE; payload jsonb;
BEGIN
  IF TG_TABLE_NAME='sales_commercial_allocation' THEN
    PERFORM public.sales_assert_ticket_open(NEW.tenant_id,NEW.event_reference_kind,NEW.event_id,NEW.ticket_type_id,true);
  ELSIF TG_TABLE_NAME='sales_commercial_allocation_invitation' THEN
    IF TG_OP='UPDATE' AND (NEW.claimed_at IS NOT DISTINCT FROM OLD.claimed_at OR NEW.claimed_at IS NULL) THEN RETURN NEW; END IF;
    SELECT * INTO a FROM public.sales_commercial_allocation WHERE tenant_id=NEW.tenant_id AND id=NEW.allocation_id;
    PERFORM public.sales_assert_ticket_open(a.tenant_id,a.event_reference_kind,a.event_id,a.ticket_type_id,false);
  ELSE
    payload:=to_jsonb(NEW);
    IF payload->>'event_id' IS NULL THEN RETURN NEW; END IF;
    IF payload->>'status' IN ('cancelled','canceled','failed','refunded') THEN RETURN NEW; END IF;
    PERFORM public.sales_assert_ticket_open((payload->>'tenant_id')::uuid,
      CASE WHEN TG_TABLE_NAME='complex_event_booking' THEN 'complex' ELSE 'simple' END,
      (payload->>'event_id')::uuid,NULLIF(payload->>'ticket_class_id',''),false);
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.sales_guard_ticket_lifecycle() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER sales_allocation_eligible BEFORE INSERT ON public.sales_commercial_allocation
  FOR EACH ROW EXECUTE FUNCTION public.sales_guard_ticket_lifecycle();
CREATE TRIGGER sales_invitation_open BEFORE INSERT OR UPDATE OF claimed_at ON public.sales_commercial_allocation_invitation
  FOR EACH ROW EXECUTE FUNCTION public.sales_guard_ticket_lifecycle();
CREATE TRIGGER ticket_booking_open BEFORE INSERT ON public.booking
  FOR EACH ROW EXECUTE FUNCTION public.sales_guard_ticket_lifecycle();
CREATE TRIGGER ticket_booking_open BEFORE INSERT ON public.complex_event_booking
  FOR EACH ROW EXECUTE FUNCTION public.sales_guard_ticket_lifecycle();

CREATE FUNCTION public.sales_guard_bundle_ticket_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF NEW.component_kind='ticket' THEN
    PERFORM public.sales_assert_ticket_open(NEW.tenant_id,NEW.event_reference_kind,NEW.event_id,NEW.ticket_type_id,true);
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.sales_guard_bundle_ticket_reference() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER sales_bundle_ticket_reference BEFORE INSERT OR UPDATE ON public.sales_catalogue_bundle_item
  FOR EACH ROW EXECUTE FUNCTION public.sales_guard_bundle_ticket_reference();

-- Whole-event rows precede ticket locks in acceptance, including complex events.
DO $locks$
DECLARE def text; patched text;
BEGIN
  SELECT pg_get_functiondef('public.confirm_sales_quote_ticket_sale(uuid,uuid,integer,text,text,uuid)'::regprocedure) INTO def;
  patched:=replace(def,'-- Every transaction takes all ticket locks',
    'PERFORM e.id FROM public.complex_event e WHERE e.tenant_id=p_tenant_id AND e.id IN
      (SELECT c.event_id FROM pg_temp.sale_candidates c WHERE c.event_reference_kind=''complex'')
      ORDER BY e.id FOR SHARE;
    -- Every transaction takes all ticket locks');
  IF patched=def THEN RAISE EXCEPTION 'Unknown acceptance lock contract'; END IF;
  EXECUTE patched;
END $locks$;
DO $discovery$
DECLARE def text; patched text;
BEGIN
  SELECT pg_get_functiondef('public.sales_ticket_event_options(uuid,text,integer,uuid,text)'::regprocedure) INTO def;
  def:=replace(def,'''id'', t->>''id'',',
    '''close_at'', t->>''close_at'', ''close_timezone'', t->>''close_timezone'', ''id'', t->>''id'',');
  def:=replace(def,'''id'', t.id,',
    '''close_at'', t.close_at, ''close_timezone'', t.close_timezone, ''id'', t.id,');
  patched:=replace(def,'WHERE NULLIF(t->>''id'','''') IS NOT NULL',
    'WHERE NULLIF(t->>''id'','''') IS NOT NULL AND (p_selected IS NOT NULL OR
      (t->>''close_at'' IS NULL AND t->>''close_timezone'' IS NULL)
      OR public.sales_ticket_known_instant(t->>''close_at'')>statement_timestamp())');
  patched:=replace(patched,'WHERE t.tenant_id=p_tenant AND t.complex_event_id=e.id',
    'WHERE t.tenant_id=p_tenant AND t.complex_event_id=e.id
      AND (p_selected IS NOT NULL OR t.close_at IS NULL OR t.close_at>statement_timestamp())');
  IF patched=def THEN RAISE EXCEPTION 'Unknown ticket discovery contract'; END IF;
  EXECUTE patched;
END $discovery$;
NOTIFY pgrst,'reload schema';
COMMIT;
