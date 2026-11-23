BEGIN;
CREATE TABLE public.event_funnel_integration_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,order_id uuid NOT NULL,
  booking_source text NOT NULL,booking_id uuid NOT NULL,
  step text NOT NULL CHECK(step IN ('checkin','notifications','providers')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete')),
  completed_at timestamptz,
  UNIQUE(tenant_id,order_id,booking_source,booking_id,step),
  FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id),
  FOREIGN KEY(tenant_id,booking_source,booking_id) REFERENCES public.event_funnel_order_booking(tenant_id,booking_source,booking_id)
);
ALTER TABLE public.event_funnel_integration_step ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_integration_step FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.event_funnel_integration_operation(
  p_tenant uuid,p_order uuid,p_token uuid,p_action text,p_step uuid DEFAULT NULL,p_rows jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item public.event_funnel_integration_step;b jsonb;e jsonb;rows jsonb:='[]';r jsonb;template jsonb;
BEGIN
  PERFORM 1 FROM public.event_funnel_delivery d JOIN public.event_funnel_order o
    ON o.id=d.order_id AND o.tenant_id=d.tenant_id WHERE d.tenant_id=p_tenant AND d.order_id=p_order
    AND d.kind='integrations' AND d.state='running' AND d.lease_token=p_token
    AND d.lease_until>clock_timestamp() AND o.state='confirmed' FOR UPDATE OF d;
  IF NOT FOUND THEN RAISE EXCEPTION 'Integration lease unavailable' USING ERRCODE='PT409'; END IF;
  IF p_action='read' THEN
    INSERT INTO public.event_funnel_integration_step(tenant_id,order_id,booking_source,booking_id,step)
      SELECT b.tenant_id,b.order_id,b.booking_source,b.booking_id,s FROM public.event_funnel_order_booking b
      CROSS JOIN unnest(ARRAY['checkin','notifications','providers']) s
      WHERE b.tenant_id=p_tenant AND b.order_id=p_order ON CONFLICT DO NOTHING;
    FOR item IN SELECT * FROM public.event_funnel_integration_step WHERE tenant_id=p_tenant AND order_id=p_order
      AND state='pending' ORDER BY CASE step WHEN 'checkin' THEN 0 WHEN 'providers' THEN 1 ELSE 2 END,id LIMIT 8 LOOP
      EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE tenant_id=$1 AND id=$2',item.booking_source)
        INTO b USING p_tenant,item.booking_id;
      IF b IS NULL OR b->>'status' IS DISTINCT FROM 'confirmed' THEN
        RAISE EXCEPTION 'Confirmed registration unavailable' USING ERRCODE='PT409'; END IF;
      EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE tenant_id=$1 AND id=$2',
        CASE WHEN item.booking_source='booking' THEN 'event' ELSE 'complex_event' END)
        INTO e USING p_tenant,(b->>'event_id')::uuid;
      IF e IS NULL THEN RAISE EXCEPTION 'Event unavailable' USING ERRCODE='PT409'; END IF;
      rows:=rows||jsonb_build_array(to_jsonb(item)||jsonb_build_object('booking',b,'event',e));
    END LOOP;
    RETURN jsonb_build_object('jobs',rows,'serverNow',clock_timestamp(),
      'status',CASE WHEN EXISTS(SELECT 1 FROM public.event_funnel_integration_step WHERE tenant_id=p_tenant AND order_id=p_order
        AND state='pending') THEN 'retry' ELSE 'delivered' END);
  END IF;
  SELECT * INTO item FROM public.event_funnel_integration_step WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_step FOR UPDATE;
  IF NOT FOUND OR p_action IS DISTINCT FROM 'finish' THEN RAISE EXCEPTION 'Invalid integration step'; END IF;
  IF item.state='complete' THEN RETURN jsonb_build_object('saved',true); END IF;
  EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE tenant_id=$1 AND id=$2 FOR UPDATE',item.booking_source)
    INTO b USING p_tenant,item.booking_id;
  IF b IS NULL OR b->>'status' IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'Registration changed' USING ERRCODE='PT409'; END IF;
  IF item.step='notifications' THEN
    PERFORM 1 FROM public.event_funnel_integration_step WHERE tenant_id=p_tenant AND order_id=p_order
      AND booking_source=item.booking_source AND booking_id=item.booking_id AND step='providers' AND state='complete';
    IF NOT FOUND THEN RAISE EXCEPTION 'Provider preparation is not complete' USING ERRCODE='PT409'; END IF;
    IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>2000
      OR octet_length(p_rows::text)>1048576 THEN RAISE EXCEPTION 'Invalid notification plan'; END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
      SELECT to_jsonb(t) INTO template FROM public.event_email t WHERE t.tenant_id=p_tenant
        AND t.event_id=(b->>'event_id')::uuid AND t.id=(r->>'event_email_id')::uuid
        AND t.is_enabled=true AND t.email_type IN ('reminder','follow_up');
      IF template IS NULL OR r->>'booking_id' IS DISTINCT FROM item.booking_id::text
        OR r->>'attendee_email' IS DISTINCT FROM b->>'attendee_email'
        OR r->>'status' IS DISTINCT FROM 'pending'
        OR r->>'scheduled_send_time' IS NULL THEN RAISE EXCEPTION 'Notification scope changed'; END IF;
      IF (template->>'email_type'='follow_up') IS DISTINCT FROM (r->>'follow_up_target_key' IS NOT NULL)
        OR (r->>'follow_up_target_key' IS NOT NULL AND r->>'follow_up_booking_table' IS DISTINCT FROM item.booking_source) THEN
        RAISE EXCEPTION 'Notification type changed'; END IF;
      IF r->>'session_id' IS NOT NULL THEN
        IF item.booking_source='complex_event_booking' THEN
          PERFORM 1 FROM public.complex_event_session WHERE id=(r->>'session_id')::uuid
            AND complex_event_id=(b->>'event_id')::uuid AND tenant_id=p_tenant;
        ELSE
          PERFORM 1 FROM public.event_agenda_item WHERE id=(r->>'session_id')::uuid AND event_id=(b->>'event_id')::uuid;
        END IF;
        IF NOT FOUND THEN RAISE EXCEPTION 'Notification session changed'; END IF;
      END IF;
      -- The existing ordinary-reminder and follow-up unique indexes also fence
      -- concurrent admin schedulers; do not rewrite pending or sent rows.
      INSERT INTO public.scheduled_email(event_email_id,booking_id,attendee_email,scheduled_send_time,status,
        session_id,training_target_snapshot,follow_up_target_key,follow_up_target_snapshot,follow_up_booking_table)
      VALUES((r->>'event_email_id')::uuid,item.booking_id,r->>'attendee_email',(r->>'scheduled_send_time')::timestamptz,
        'pending',(r->>'session_id')::uuid,r->>'training_target_snapshot',r->>'follow_up_target_key',
        r->>'follow_up_target_snapshot',r->>'follow_up_booking_table') ON CONFLICT DO NOTHING;
    END LOOP;
  ELSIF p_rows IS NOT NULL THEN RAISE EXCEPTION 'Unexpected notification payload'; END IF;
  UPDATE public.event_funnel_integration_step SET state='complete',completed_at=clock_timestamp() WHERE id=item.id;
  RETURN jsonb_build_object('saved',true);
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_integration_operation(uuid,uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_integration_operation(uuid,uuid,uuid,text,uuid,jsonb) TO service_role;
COMMIT;
