BEGIN;
ALTER TABLE public.event_funnel_integration_step DROP CONSTRAINT event_funnel_integration_step_state_check,
 ADD CHECK(state IN ('pending','complete','cancelled'));
ALTER TABLE public.event_funnel_confirmation DROP CONSTRAINT event_funnel_confirmation_state_check,
 ADD CHECK(state IN ('pending','writing','delivered','needs_review','cancelled'));

-- Suppression is not provider revocation or proof that an uncertain email was
-- never sent. Preserve all already-started work and its receipts for recovery.
CREATE FUNCTION public.event_funnel_suppress_cancelled_delivery(p_tenant uuid,p_order uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b public.event_funnel_order_booking;current_status text;
BEGIN
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='PT404';END IF;
 FOR b IN SELECT * FROM public.event_funnel_order_booking WHERE tenant_id=p_tenant AND order_id=p_order
   ORDER BY booking_source,booking_id LOOP
   EXECUTE format('SELECT status FROM public.%I WHERE tenant_id=$1 AND id=$2',b.booking_source)
     INTO current_status USING p_tenant,b.booking_id;
   IF current_status='cancelled' THEN
     UPDATE public.event_funnel_integration_step SET state='cancelled',completed_at=clock_timestamp()
       WHERE tenant_id=p_tenant AND order_id=p_order AND booking_source=b.booking_source
         AND booking_id=b.booking_id AND state='pending';
     UPDATE public.event_funnel_confirmation SET state='cancelled'
       WHERE tenant_id=p_tenant AND order_id=p_order AND booking_source=b.booking_source
         AND booking_id=b.booking_id AND state='pending';
     -- The ordinary worker claims pending rows into a non-retryable status
     -- before preparing a send. Do not rewrite those uncertain/sent attempts.
     -- Template tenant, event and model disambiguate equal booking UUIDs.
     UPDATE public.scheduled_email scheduled SET status='cancelled'
       FROM public.event_email template
       WHERE scheduled.event_email_id=template.id AND template.tenant_id=p_tenant
         AND template.event_id=b.event_id AND scheduled.booking_id=b.booking_id
         AND scheduled.status='pending'
         AND CASE WHEN coalesce((to_jsonb(template)->>'is_complex_event')::boolean,false)
           THEN 'complex_event_booking' ELSE 'booking' END=b.booking_source
         AND (scheduled.follow_up_booking_table IS NULL OR scheduled.follow_up_booking_table=b.booking_source);
   END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_suppress_cancelled_delivery(uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;

-- Admission to an external write shares the cancellation's order lock. Calls
-- already admitted before cancellation may still finish; never erase that
-- uncertainty or permit a second send/create to resolve it.
DO $$
DECLARE signature text;def text;needle text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
   'public.event_funnel_integration_operation(uuid,uuid,uuid,text,uuid,jsonb)',
   'public.event_funnel_confirmation_operation(uuid,uuid,uuid,text,uuid,jsonb)',
   'public.event_funnel_zoom_operation(uuid,uuid,uuid,uuid,text,uuid,jsonb)'] LOOP
   SELECT pg_get_functiondef(signature::regprocedure) INTO def;
   needle:=E'BEGIN\n';
   IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected delivery function baseline';END IF;
   def:=overlay(def placing needle||$lock$
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='PT404';END IF;
$lock$ from position(needle IN def) for length(needle));
   EXECUTE def;
 END LOOP;

 SELECT pg_get_functiondef('public.event_funnel_integration_operation(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure) INTO def;
 needle:='FOR item IN SELECT * FROM public.event_funnel_integration_step';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected integration reader baseline';END IF;
 def:=replace(def,needle,'PERFORM public.event_funnel_suppress_cancelled_delivery(p_tenant,p_order); '||needle);
 needle:='IF item.state=''complete'' THEN';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected integration finish baseline';END IF;
 def:=replace(def,needle,$patch$
 IF item.state='cancelled' THEN RETURN jsonb_build_object('saved',true,'cancelled',true);END IF;
 $patch$||needle);
 EXECUTE def;

 SELECT pg_get_functiondef('public.event_funnel_confirmation_operation(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure) INTO def;
 needle:='IF p_action=''read'' THEN';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected confirmation reader baseline';END IF;
 def:=replace(def,needle,'PERFORM public.event_funnel_suppress_cancelled_delivery(p_tenant,p_order); '||needle);
 needle:='INSERT INTO public.event_funnel_confirmation(tenant_id,order_id,booking_source,booking_id,event_id,template_id,booking,template)';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected confirmation planner baseline';END IF;
 def:=replace(def,needle,$patch$
 IF row_data->>'status'='cancelled' THEN CONTINUE;END IF;
 IF row_data->>'status' IS DISTINCT FROM 'confirmed' THEN
   RAISE EXCEPTION 'Registration unavailable' USING ERRCODE='PT409';END IF;
 $patch$||needle);
 EXECUTE def;

 SELECT pg_get_functiondef('public.event_funnel_zoom_operation(uuid,uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure) INTO def;
 needle:='IF b IS NULL OR b->>''status'' IS DISTINCT FROM ''confirmed'' OR nullif(trim(b->>''attendee_email''),'''') IS NULL';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected Zoom authority baseline';END IF;
 def:=replace(def,needle,$patch$
 IF b IS NULL OR NOT(coalesce(b->>'status'='confirmed',false)
   OR coalesce(b->>'status'='cancelled' AND p_action IN ('read','observed','not_submitted'),false))
   OR nullif(trim(b->>'attendee_email'),'') IS NULL
 $patch$);
 EXECUTE def;

 SELECT pg_get_functiondef('public.event_funnel_reversal_cancel(uuid,uuid,uuid)'::regprocedure) INTO def;
 needle:='IF r.cancelled_at IS NOT NULL THEN RETURN r.stock_receipt;END IF;';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected cancellation replay baseline';END IF;
 def:=replace(def,needle,$patch$
 IF r.cancelled_at IS NOT NULL THEN
   PERFORM public.event_funnel_suppress_cancelled_delivery(p_tenant,p_order);
   RETURN r.stock_receipt;
 END IF;
 $patch$);
 needle:='RETURN receipt;';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected cancellation commit baseline';END IF;
 EXECUTE replace(def,needle,'PERFORM public.event_funnel_suppress_cancelled_delivery(p_tenant,p_order); '||needle);
END $$;
COMMIT;
