BEGIN;
ALTER TABLE public.event_funnel_reversal ADD COLUMN cancellation_xid bigint,
 ADD COLUMN cancelled_at timestamptz,ADD COLUMN stock_receipt jsonb;
-- Transaction-bound, private authority: never a browser-settable session flag.
DO $$
DECLARE def text;needle text:='IF to_jsonb(OLD)->k IS DISTINCT FROM to_jsonb(NEW)->k THEN';
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_booking_financial_guard()'::regprocedure) INTO def;
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected financial guard baseline';END IF;
 EXECUTE replace(def,needle,$patch$
 IF k='status' AND OLD.status='confirmed' AND NEW.status='cancelled' AND EXISTS(
   SELECT 1 FROM public.event_funnel_reversal r CROSS JOIN LATERAL jsonb_array_elements(r.allocations) a
   WHERE r.tenant_id=OLD.tenant_id AND r.cancellation_xid=txid_current() AND r.cancelled_at IS NULL
     AND a.value->>'source'=TG_TABLE_NAME AND (a.value->>'id')::uuid=OLD.id
 ) THEN CONTINUE;END IF;
 $patch$||needle);
END $$;
CREATE FUNCTION public.event_funnel_reversal_cancel(p_tenant uuid,p_order uuid,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_reversal;item jsonb;b public.event_funnel_order_booking;
 ev record;evidence public.event_funnel_inventory_evidence;event_data jsonb;current_status text;
 source_table text;restored bigint;receipt jsonb:='[]';
BEGIN
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='PT404';END IF;
 SELECT * INTO r FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_id FOR UPDATE;
 IF NOT FOUND OR r.state='released' THEN RAISE EXCEPTION 'Reversal unavailable' USING ERRCODE='PT404';END IF;
 IF r.cancelled_at IS NOT NULL THEN RETURN r.stock_receipt;END IF;
 IF r.card_state<>'reserved' OR r.training_receipt IS NOT NULL THEN
   RAISE EXCEPTION 'Financial effects require reconciliation before cancellation' USING ERRCODE='PT409';
 END IF;
 -- Inventory writers use this same deterministic event order before bookings.
 FOR ev IN SELECT DISTINCT CASE WHEN link.booking_source='booking' THEN 'simple' ELSE 'complex' END kind,link.event_id
   FROM public.event_funnel_order_booking link JOIN jsonb_array_elements(r.allocations) a
     ON a.value->>'source'=link.booking_source AND (a.value->>'id')::uuid=link.booking_id
   WHERE link.tenant_id=p_tenant AND link.order_id=p_order ORDER BY kind,event_id LOOP
   PERFORM public.event_funnel_lock_event(p_tenant,ev.kind,ev.event_id);
 END LOOP;
 UPDATE public.event_funnel_reversal SET cancellation_xid=txid_current() WHERE id=p_id;
 FOR item IN SELECT value FROM jsonb_array_elements(r.allocations) ORDER BY value->>'source',value->>'id' LOOP
   SELECT * INTO STRICT b FROM public.event_funnel_order_booking WHERE tenant_id=p_tenant AND order_id=p_order
     AND booking_source=item->>'source' AND booking_id=(item->>'id')::uuid;
   EXECUTE format('SELECT status FROM public.%I WHERE tenant_id=$1 AND id=$2 FOR UPDATE',b.booking_source)
     INTO current_status USING p_tenant,b.booking_id;
   IF current_status IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'Registration changed before cancellation' USING ERRCODE='PT409';END IF;
   IF EXISTS(SELECT 1 FROM public.sales_commercial_allocation_booking WHERE tenant_id=p_tenant
     AND booking_id=b.booking_id AND booking_kind=CASE WHEN b.booking_source='booking' THEN 'simple' ELSE 'complex' END) THEN
     RAISE EXCEPTION 'Commercially reassigned registration requires reconciliation' USING ERRCODE='PT409';
   END IF;
   EXECUTE format('UPDATE public.%I SET status=''cancelled'' WHERE tenant_id=$1 AND id=$2',b.booking_source)
     USING p_tenant,b.booking_id;
 END LOOP;
 FOR ev IN SELECT CASE WHEN link.booking_source='booking' THEN 'simple' ELSE 'complex' END kind,link.event_id,sum(link.places)::bigint places
   FROM public.event_funnel_order_booking link JOIN jsonb_array_elements(r.allocations) a
     ON a.value->>'source'=link.booking_source AND (a.value->>'id')::uuid=link.booking_id
   WHERE link.tenant_id=p_tenant AND link.order_id=p_order GROUP BY kind,link.event_id ORDER BY kind,link.event_id LOOP
   SELECT * INTO evidence FROM public.event_funnel_inventory_evidence WHERE tenant_id=p_tenant AND order_id=p_order
     AND event_kind=ev.kind AND event_id=ev.event_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original stock movement needs reconciliation' USING ERRCODE='PT409';END IF;
   restored:=0;
   IF evidence.legacy_debit_places>0 THEN
     IF ev.places>evidence.legacy_debit_places-evidence.restored_places THEN RAISE EXCEPTION 'Stock already restored' USING ERRCODE='PT409';END IF;
     source_table:=CASE WHEN ev.kind='simple' THEN 'event' ELSE 'complex_event' END;
     EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE tenant_id=$1 AND id=$2',source_table)
       INTO event_data USING p_tenant,ev.event_id;
     IF public.event_funnel_counter_is_finite(ev.kind,event_data) THEN
       EXECUTE format('UPDATE public.%I SET available_seats=available_seats+$1 WHERE tenant_id=$2 AND id=$3',source_table)
         USING ev.places,p_tenant,ev.event_id;
       restored:=ev.places;
     END IF;
     UPDATE public.event_funnel_inventory_evidence SET restored_places=restored_places+ev.places
       WHERE tenant_id=p_tenant AND order_id=p_order AND event_kind=ev.kind AND event_id=ev.event_id;
   END IF;
   receipt:=receipt||jsonb_build_array(jsonb_build_object('eventKind',ev.kind,'eventId',ev.event_id,
     'places',ev.places,'counterIncrement',restored));
 END LOOP;
 UPDATE public.event_funnel_reversal SET cancelled_at=clock_timestamp(),stock_receipt=receipt,cancellation_xid=NULL WHERE id=p_id;
 RETURN receipt;
END $$;
DO $$
DECLARE def text;needle text:='IF p_action=''begin'' THEN';
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_reversal_card(uuid,uuid,uuid,text,jsonb)'::regprocedure) INTO def;
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected card reversal baseline';END IF;
 EXECUTE replace(def,needle,needle||' IF r.cancelled_at IS NULL THEN RETURN false;END IF;');
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_reversal_cancel(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_reversal_cancel(uuid,uuid,uuid) TO service_role;
COMMIT;
