-- Explicit opt-in only. No historical counter is interpreted or backfilled as a total.
BEGIN;
ALTER TABLE public.event
  ADD COLUMN capacity_mode text NOT NULL DEFAULT 'legacy'
    CHECK (capacity_mode IN ('legacy','total')),
  ADD COLUMN total_capacity integer CHECK (total_capacity >= 0);

CREATE FUNCTION public.simple_event_capacity(p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE e public.event; confirmed bigint; unused bigint;
BEGIN
  SELECT * INTO e FROM public.event WHERE id=p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  SELECT count(*) INTO confirmed FROM public.booking
    WHERE event_id=e.id AND tenant_id=e.tenant_id AND status='confirmed';
  SELECT coalesce(sum(greatest(remaining-named-reserved,0)),0) INTO unused
    FROM public.sales_commercial_allocation_totals
    WHERE tenant_id=e.tenant_id AND event_id=e.id AND event_reference_kind='simple';
  RETURN jsonb_build_object('total',e.total_capacity,'confirmed',confirmed,
    'commercial_unused',unused,'used',confirmed+unused,
    'remaining',CASE WHEN e.total_capacity IS NULL THEN NULL
      ELSE greatest(0,e.total_capacity-confirmed-unused) END);
END $$;

-- Keep the old mutable counter inert for total-mode events. Existing RPCs (including
-- cancellation and credit reversal) may still write it; they cannot change the maximum.
CREATE FUNCTION public.simple_event_capacity_contract()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.capacity_mode='total' AND NEW.capacity_mode<>'total' THEN
    RAISE EXCEPTION 'Total capacity cannot be converted back into a legacy counter';
  END IF;
  IF NEW.capacity_mode='total' THEN
    IF coalesce(NEW.is_complex,false) THEN RAISE EXCEPTION 'Total capacity is for simple events only'; END IF;
    NEW.available_seats:=NULL;
    NEW.is_unlimited_registration:=(NEW.total_capacity IS NULL);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER simple_event_capacity_contract BEFORE INSERT OR UPDATE ON public.event
FOR EACH ROW EXECUTE FUNCTION public.simple_event_capacity_contract();

-- All capacity-producing writers share the event row lock, even across ticket classes.
-- Remember the transaction's initial occupancy, so naming an already committed place
-- and releasing places remain possible when an administrator has lowered the maximum.
CREATE FUNCTION public.lock_simple_event_capacity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE event_id uuid; mode text; baseline text; state jsonb;
BEGIN
  IF TG_TABLE_NAME='booking' THEN
    event_id:=NEW.event_id;
  ELSE
    SELECT a.event_id INTO event_id FROM public.sales_commercial_allocation a
      WHERE a.id=NEW.allocation_id AND a.tenant_id=NEW.tenant_id AND a.event_reference_kind='simple';
  END IF;
  IF event_id IS NULL THEN RETURN NEW; END IF;
  SELECT capacity_mode INTO mode FROM public.event WHERE id=event_id FOR UPDATE;
  IF mode IS DISTINCT FROM 'total' THEN RETURN NEW; END IF;
  baseline:=current_setting('event_capacity.e_'||replace(event_id::text,'-',''),true);
  IF baseline IS NULL OR baseline='' THEN
    state:=public.simple_event_capacity(event_id);
    PERFORM set_config('event_capacity.e_'||replace(event_id::text,'-',''),state->>'used',true);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER simple_event_capacity_lock BEFORE INSERT OR UPDATE ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.lock_simple_event_capacity();
CREATE TRIGGER simple_event_commercial_capacity_lock BEFORE INSERT ON public.sales_commercial_allocation_movement
FOR EACH ROW EXECUTE FUNCTION public.lock_simple_event_capacity();

CREATE FUNCTION public.verify_simple_event_capacity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE event_id uuid; e public.event; state jsonb; baseline bigint;
BEGIN
  IF TG_TABLE_NAME='booking' THEN event_id:=NEW.event_id;
  ELSE
    SELECT a.event_id INTO event_id FROM public.sales_commercial_allocation a
      WHERE a.id=NEW.allocation_id AND a.tenant_id=NEW.tenant_id AND a.event_reference_kind='simple';
  END IF;
  SELECT * INTO e FROM public.event WHERE id=event_id;
  IF e.capacity_mode='total' AND e.total_capacity IS NOT NULL THEN
    state:=public.simple_event_capacity(event_id);
    baseline:=current_setting('event_capacity.e_'||replace(event_id::text,'-',''),true)::bigint;
    IF (state->>'used')::bigint>e.total_capacity AND (state->>'used')::bigint>baseline THEN
      RAISE EXCEPTION 'Event capacity unavailable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER simple_event_capacity_verify AFTER INSERT OR UPDATE ON public.booking
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.verify_simple_event_capacity();
CREATE CONSTRAINT TRIGGER simple_event_commercial_capacity_verify AFTER INSERT ON public.sales_commercial_allocation_movement
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.verify_simple_event_capacity();

-- Ordinary bookings must also be all-or-nothing: never retain half a paid group.
CREATE FUNCTION public.insert_simple_total_booking_batch(
  p_event_id uuid,p_rows jsonb,p_allocation_token_hash text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.event; r jsonb; inserted jsonb; rows_out jsonb:='[]'; cols text; vals text;
DECLARE class_id text; ids uuid[]; capacity jsonb;
BEGIN
  SELECT * INTO e FROM public.event WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND OR e.capacity_mode<>'total' OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid total-capacity booking batch' USING ERRCODE='23514';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF r->>'event_id' IS DISTINCT FROM e.id::text OR r->>'tenant_id' IS DISTINCT FROM e.tenant_id::text
       OR r->>'status' IS DISTINCT FROM 'confirmed' THEN
      RAISE EXCEPTION 'Invalid booking scope' USING ERRCODE='23514';
    END IF;
    SELECT string_agg(format('%I',key),','),string_agg(format('(x.r).%I',key),',') INTO cols,vals
      FROM jsonb_object_keys(r) key WHERE EXISTS(SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema='public' AND c.table_name='booking' AND c.column_name=key);
    EXECUTE format('INSERT INTO public.booking (%s) SELECT %s FROM
      (SELECT jsonb_populate_record(NULL::public.booking,$1) r) x RETURNING to_jsonb(booking.*)',cols,vals)
      INTO inserted USING r;
    rows_out:=rows_out||jsonb_build_array(inserted);
  END LOOP;
  IF p_allocation_token_hash IS NOT NULL THEN
    IF jsonb_array_length(rows_out)<>1 THEN RAISE EXCEPTION 'Allocation requires one booking'; END IF;
    PERFORM public.claim_sales_allocation_invitation(p_allocation_token_hash,'simple',(rows_out->0->>'id')::uuid);
  END IF;
  FOR class_id IN SELECT DISTINCT value->>'ticket_class_id' FROM jsonb_array_elements(rows_out)
      WHERE value->>'ticket_class_id' IS NOT NULL ORDER BY 1 LOOP
    SELECT array_agg((value->>'id')::uuid) INTO ids FROM jsonb_array_elements(rows_out)
      WHERE value->>'ticket_class_id'=class_id;
    capacity:=public.check_oneoff_ticket_capacity(p_event_id,class_id,cardinality(ids),ids);
    IF (capacity->>'ok')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Ticket capacity unavailable' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN rows_out;
END $$;
REVOKE ALL ON FUNCTION public.insert_simple_total_booking_batch(uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.insert_simple_total_booking_batch(uuid,jsonb,text) TO service_role;

-- Acquire the event lock BEFORE class locks; retain the existing per-ticket guard,
-- idempotency, loser cleanup and commercial accounting unchanged.
DO $patch$
DECLARE def text; patched text;
BEGIN
  SELECT pg_get_functiondef('public.sales_capacity_state(text,uuid,text)'::regprocedure) INTO def;
  patched:=replace(def, '  PERFORM pg_advisory_xact_lock', $insert$
  IF p_event_kind='simple' THEN
    PERFORM 1 FROM public.event WHERE id=p_event_id FOR UPDATE;
  END IF;
  PERFORM pg_advisory_xact_lock$insert$);
  IF patched=def THEN RAISE EXCEPTION 'Unexpected sales_capacity_state contract'; END IF;
  EXECUTE patched;

  SELECT pg_get_functiondef('public.check_oneoff_ticket_capacity(uuid,text,integer,uuid[])'::regprocedure) INTO def;
  patched:=replace(def, ' s:=public.sales_capacity_state', $insert$
 IF p_booking_ids IS NULL AND EXISTS(SELECT 1 FROM public.event WHERE id=p_event_id AND capacity_mode='total') THEN
   PERFORM 1 FROM public.event WHERE id=p_event_id FOR UPDATE;
   s:=public.simple_event_capacity(p_event_id);
   IF s->>'total' IS NOT NULL AND (s->>'remaining')::bigint<greatest(coalesce(p_requested,1),0) THEN
     RETURN s||jsonb_build_object('ok',false,'unlimited',false);
   END IF;
 END IF;
 s:=public.sales_capacity_state$insert$);
  IF patched=def THEN RAISE EXCEPTION 'Unexpected oneoff capacity guard contract'; END IF;
  EXECUTE patched;

  -- Public batch failures must retain the explicit compensation outcome rather than
  -- surfacing as an ambiguous transaction failure after a captured payment.
  SELECT pg_get_functiondef('public.insert_public_ticket_booking_batch(uuid,jsonb)'::regprocedure) INTO def;
  patched:=replace(def, '  FOR ticket IN SELECT', $insert$
  IF purchase.event_kind='simple' THEN
    PERFORM 1 FROM public.event WHERE id=purchase.event_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.event WHERE id=purchase.event_id AND capacity_mode='total'
        AND total_capacity IS NOT NULL)
      AND (public.simple_event_capacity(purchase.event_id)->>'remaining')::bigint<expected_count THEN
      UPDATE public.public_ticket_member_purchase SET
        state=CASE WHEN stripe_payment_intent_id IS NULL THEN 'excluded' ELSE 'retryable' END,
        last_error_code='capacity_refund_pending',updated_at=now() WHERE id=purchase.id;
      RETURN jsonb_build_object('error','capacity_unavailable');
    END IF;
  END IF;
  FOR ticket IN SELECT$insert$);
  IF patched=def THEN RAISE EXCEPTION 'Unexpected public booking batch contract'; END IF;
  EXECUTE patched;
END $patch$;

-- Existing commercial entry points used to take a class/invitation lock first.
-- Establish the same event-before-class order before those locks, preventing a
-- sale or invitation operation from deadlocking an ordinary event-wide batch.
DO $locks$
DECLARE target record; fn record; def text; prefix text; patched text;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('move_sales_commercial_allocation','allocation'),
    ('reconcile_sales_commercial_booking','allocation'),
    ('unreconcile_sales_commercial_booking','booking'),
    ('cancel_event_booking_with_allocation','booking'),
    ('reserve_sales_allocation_invitation','allocation'),
    ('claim_sales_allocation_invitation','token'),
    ('release_sales_allocation_invitation','invitation')
  ) AS targets(name,kind) LOOP
    FOR fn IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=target.name LOOP
      prefix:=CASE target.kind
        WHEN 'allocation' THEN 'PERFORM capacity_event.id FROM public.event capacity_event JOIN public.sales_commercial_allocation capacity_allocation ON capacity_allocation.event_id=capacity_event.id AND capacity_allocation.tenant_id=capacity_event.tenant_id WHERE capacity_allocation.id=p_allocation_id AND capacity_allocation.tenant_id=p_tenant_id AND capacity_allocation.event_reference_kind=''simple'' FOR UPDATE OF capacity_event;'
        WHEN 'booking' THEN 'PERFORM capacity_event.id FROM public.event capacity_event JOIN public.booking capacity_booking ON capacity_booking.event_id=capacity_event.id AND capacity_booking.tenant_id=capacity_event.tenant_id WHERE capacity_booking.id=p_booking_id AND capacity_booking.tenant_id=p_tenant_id AND p_booking_kind=''simple'' FOR UPDATE OF capacity_event;'
        WHEN 'token' THEN 'PERFORM capacity_event.id FROM public.event capacity_event JOIN public.sales_commercial_allocation capacity_allocation ON capacity_allocation.event_id=capacity_event.id AND capacity_allocation.tenant_id=capacity_event.tenant_id JOIN public.sales_commercial_allocation_invitation capacity_invitation ON capacity_invitation.allocation_id=capacity_allocation.id AND capacity_invitation.tenant_id=capacity_allocation.tenant_id WHERE capacity_invitation.token_hash=decode(p_token_hash,''hex'') AND capacity_allocation.event_reference_kind=''simple'' FOR UPDATE OF capacity_event;'
        WHEN 'invitation' THEN 'PERFORM capacity_event.id FROM public.event capacity_event JOIN public.sales_commercial_allocation capacity_allocation ON capacity_allocation.event_id=capacity_event.id AND capacity_allocation.tenant_id=capacity_event.tenant_id JOIN public.sales_commercial_allocation_invitation capacity_invitation ON capacity_invitation.allocation_id=capacity_allocation.id AND capacity_invitation.tenant_id=capacity_allocation.tenant_id WHERE capacity_invitation.id=p_invitation_id AND capacity_invitation.tenant_id=p_tenant_id AND capacity_allocation.event_reference_kind=''simple'' FOR UPDATE OF capacity_event;'
      END;
      def:=pg_get_functiondef(fn.oid);
      patched:=regexp_replace(def,E'BEGIN\\n',E'BEGIN\n  '||prefix||E'\n');
      IF patched=def THEN RAISE EXCEPTION 'Unexpected commercial function contract: %',target.name; END IF;
      EXECUTE patched;
    END LOOP;
  END LOOP;
  FOR fn IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('confirm_sales_quote_sale','confirm_sales_quote_ticket_sale')
        AND position('pg_temp.sale_candidates' IN p.prosrc)>0 LOOP
    def:=pg_get_functiondef(fn.oid);
    patched:=replace(def,'-- Every transaction takes all ticket locks', $insert$
  PERFORM e.id FROM public.event e WHERE e.id IN
    (SELECT c.event_id FROM pg_temp.sale_candidates c WHERE c.event_reference_kind='simple')
    ORDER BY e.id FOR UPDATE;
  -- Every transaction takes all ticket locks$insert$);
    IF patched=def THEN RAISE EXCEPTION 'Unexpected commercial sale confirmation contract'; END IF;
    EXECUTE patched;
  END LOOP;
END $locks$;

REVOKE ALL ON FUNCTION public.simple_event_capacity(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.simple_event_capacity_contract() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.lock_simple_event_capacity() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.verify_simple_event_capacity() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.simple_event_capacity(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
