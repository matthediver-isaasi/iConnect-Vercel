BEGIN;
-- Complete only the explicitly quiet path. External access revocation and
-- requested cancellation emails require their own durable receipts, not a
-- caller's boolean assertion that cleanup succeeded.
CREATE FUNCTION public.event_funnel_cancellation_cleanup_quiet(
 p_tenant uuid,p_order uuid,p_id uuid,p_lease uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_reversal;c public.event_funnel_cancellation_cleanup;
 item jsonb;booking jsonb;source text;target_booking uuid;reason text;proof jsonb;
BEGIN
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='PT404';END IF;
 SELECT * INTO r FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT r.requires_cleanup OR r.cancelled_at IS NULL OR r.state<>'processing'
   OR r.lease_id IS DISTINCT FROM p_lease OR p_lease IS NULL OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() THEN
   RAISE EXCEPTION 'Cleanup lease unavailable' USING ERRCODE='PT409';
 END IF;
 SELECT * INTO c FROM public.event_funnel_cancellation_cleanup
   WHERE tenant_id=p_tenant AND order_id=p_order AND reversal_id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Approved cleanup unavailable' USING ERRCODE='PT409';END IF;
 IF c.state='complete' THEN RETURN jsonb_build_object('status','complete','operationId',p_id,'receipt',c.receipt);END IF;
 IF c.snapshot->'authority'->'suppressEmails' IS DISTINCT FROM 'true'::jsonb THEN
   reason:='notification_receipts_required';
 END IF;
 PERFORM public.event_funnel_suppress_cancelled_delivery(p_tenant,p_order);
 FOR item IN SELECT value FROM jsonb_array_elements(r.allocations) LOOP
   source:=item->>'source';target_booking:=(item->>'id')::uuid;
   IF source NOT IN ('booking','complex_event_booking') OR source IS NULL THEN
     RAISE EXCEPTION 'Original booking model unavailable' USING ERRCODE='PT409';END IF;
   EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE tenant_id=$1 AND id=$2',source)
     INTO booking USING p_tenant,target_booking;
   IF booking IS NULL OR booking->>'status' IS DISTINCT FROM 'cancelled' THEN
     RAISE EXCEPTION 'Cancelled booking unavailable' USING ERRCODE='PT409';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.event_funnel_integration_step s WHERE s.tenant_id=p_tenant
       AND s.order_id=p_order AND s.booking_source=source AND s.booking_id=target_booking
       AND s.step='providers' AND s.provider_plan='[]'::jsonb AND s.state IN ('complete','cancelled'))
     OR EXISTS(SELECT 1 FROM public.event_funnel_zoom_link l JOIN public.event_funnel_integration_step s ON s.id=l.step_id
       WHERE s.tenant_id=p_tenant AND s.order_id=p_order AND s.booking_source=source AND s.booking_id=target_booking)
     OR EXISTS(SELECT 1 FROM jsonb_each(booking) entry WHERE entry.key~'^(zoom_|teams_|backstage_|lms_)'
       AND entry.value NOT IN ('null'::jsonb,'""'::jsonb,'false'::jsonb)) THEN
     reason:=coalesce(reason,'provider_receipts_required');
   END IF;
   IF EXISTS(SELECT 1 FROM public.event_funnel_confirmation f WHERE f.tenant_id=p_tenant AND f.order_id=p_order
       AND f.booking_source=source AND f.booking_id=target_booking AND f.state IN ('pending','writing','needs_review'))
     OR EXISTS(SELECT 1 FROM public.scheduled_email scheduled JOIN public.event_email template ON template.id=scheduled.event_email_id
       WHERE template.tenant_id=p_tenant AND template.event_id=(booking->>'event_id')::uuid
       AND scheduled.booking_id=target_booking AND scheduled.status IN ('pending','failed')
       AND CASE WHEN coalesce((to_jsonb(template)->>'is_complex_event')::boolean,false)
         THEN 'complex_event_booking' ELSE 'booking' END=source
       AND (scheduled.follow_up_booking_table IS NULL OR scheduled.follow_up_booking_table=source)) THEN
     reason:=coalesce(reason,'delivery_reconciliation_required');
   END IF;
 END LOOP;
 IF reason IS NOT NULL THEN
   UPDATE public.event_funnel_cancellation_cleanup SET state='needs_review' WHERE reversal_id=p_id;
   RETURN jsonb_build_object('status','needs_review','operationId',p_id,'reason',reason);
 END IF;
 proof:=jsonb_build_object('version',1,'providers','verified_absent','notifications','suppressed',
   'queuedMessages','settled','completedAt',clock_timestamp());
 UPDATE public.event_funnel_cancellation_cleanup SET state='complete',receipt=proof WHERE reversal_id=p_id;
 RETURN jsonb_build_object('status','complete','operationId',p_id,'receipt',proof);
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_cancellation_cleanup_quiet(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_cancellation_cleanup_quiet(uuid,uuid,uuid,uuid) TO service_role;
COMMIT;
