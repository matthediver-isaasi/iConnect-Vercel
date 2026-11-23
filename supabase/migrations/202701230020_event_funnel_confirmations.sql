BEGIN;
CREATE TABLE public.event_funnel_confirmation_plan (
  tenant_id uuid NOT NULL,order_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,order_id),
  FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
CREATE TABLE public.event_funnel_confirmation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,order_id uuid NOT NULL,
  booking_source text NOT NULL,booking_id uuid NOT NULL,event_id uuid NOT NULL,template_id uuid NOT NULL,
  booking jsonb NOT NULL,template jsonb NOT NULL,payload jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','writing','delivered','needs_review')),
  attempt_token uuid,message_id text,delivered_at timestamptz,
  UNIQUE(tenant_id,order_id,booking_source,booking_id,template_id),
  FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id),
  FOREIGN KEY(tenant_id,booking_source,booking_id) REFERENCES public.event_funnel_order_booking(tenant_id,booking_source,booking_id)
);
ALTER TABLE public.event_funnel_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_confirmation_plan ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_confirmation,public.event_funnel_confirmation_plan FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.event_funnel_confirmation_operation(
  p_tenant uuid,p_order uuid,p_token uuid,p_action text,p_item uuid DEFAULT NULL,p_payload jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b record;row_data jsonb;c public.event_funnel_confirmation;items jsonb;summary text;
BEGIN
  PERFORM 1 FROM public.event_funnel_delivery d JOIN public.event_funnel_order o
    ON o.tenant_id=d.tenant_id AND o.id=d.order_id WHERE d.tenant_id=p_tenant AND d.order_id=p_order
    AND d.kind='confirmations' AND d.state='running' AND d.lease_token=p_token
    AND d.lease_until>clock_timestamp() AND o.state='confirmed' FOR UPDATE OF d;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confirmation lease unavailable' USING ERRCODE='PT409'; END IF;
  -- Conference/session provisioning must finish before generating personalised
  -- attendance links. Accounting availability is deliberately NOT a dependency.
  IF NOT EXISTS(SELECT 1 FROM public.event_funnel_delivery WHERE tenant_id=p_tenant AND order_id=p_order
    AND kind='integrations' AND state='delivered') THEN RETURN jsonb_build_object('status','retry','jobs','[]'::jsonb); END IF;
  IF p_action='read' THEN
    IF NOT EXISTS(SELECT 1 FROM public.event_funnel_confirmation_plan WHERE tenant_id=p_tenant AND order_id=p_order) THEN
      FOR b IN SELECT * FROM public.event_funnel_order_booking WHERE tenant_id=p_tenant AND order_id=p_order LOOP
        EXECUTE format('SELECT to_jsonb(r) FROM public.%I r WHERE tenant_id=$1 AND id=$2',b.booking_source)
          INTO row_data USING p_tenant,b.booking_id;
        IF row_data IS NULL THEN RAISE EXCEPTION 'Original registration unavailable' USING ERRCODE='PT409'; END IF;
        INSERT INTO public.event_funnel_confirmation(tenant_id,order_id,booking_source,booking_id,event_id,template_id,booking,template)
          SELECT p_tenant,p_order,b.booking_source,b.booking_id,b.event_id,e.id,row_data,to_jsonb(e)
          FROM public.event_email e WHERE e.tenant_id=p_tenant AND e.event_id=b.event_id
            AND e.email_type IN ('confirmation','booking_confirmation') AND e.is_enabled=true;
      END LOOP;
      INSERT INTO public.event_funnel_confirmation_plan VALUES(p_tenant,p_order,now());
    END IF;
    SELECT CASE WHEN count(*) FILTER(WHERE state='pending')>0 THEN 'retry'
      WHEN count(*) FILTER(WHERE state IN ('writing','needs_review'))>0 THEN 'needs_review' ELSE 'delivered' END
      INTO summary FROM public.event_funnel_confirmation WHERE tenant_id=p_tenant AND order_id=p_order;
    SELECT coalesce(jsonb_agg(to_jsonb(j)),'[]'::jsonb) INTO items FROM (
      SELECT * FROM public.event_funnel_confirmation WHERE tenant_id=p_tenant AND order_id=p_order
        AND state='pending' ORDER BY id LIMIT 8) j;
    RETURN jsonb_build_object('status',summary,'jobs',items);
  END IF;
  SELECT * INTO c FROM public.event_funnel_confirmation WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_item FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confirmation unavailable' USING ERRCODE='PT404'; END IF;
  IF p_action='begin' THEN
    IF c.state='delivered' THEN RETURN jsonb_build_object('status','delivered'); END IF;
    IF c.state<>'pending' THEN RETURN jsonb_build_object('status','needs_review'); END IF;
    EXECUTE format('SELECT to_jsonb(r) FROM public.%I r WHERE tenant_id=$1 AND id=$2',c.booking_source)
      INTO row_data USING p_tenant,c.booking_id;
    IF row_data IS NULL OR row_data->>'status' IS DISTINCT FROM 'confirmed'
      OR row_data->>'attendee_email' IS DISTINCT FROM c.booking->>'attendee_email' THEN
      UPDATE public.event_funnel_confirmation SET state='needs_review' WHERE id=c.id;
      RETURN jsonb_build_object('status','needs_review');
    END IF;
    IF c.payload IS NULL THEN
      IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text)>1048576
        OR p_payload->>'tenantId' IS DISTINCT FROM p_tenant::text
        OR p_payload->>'to' IS DISTINCT FROM c.booking->>'attendee_email'
        OR coalesce(p_payload->>'to','')='' THEN RAISE EXCEPTION 'Invalid confirmation envelope'; END IF;
      c.payload:=p_payload;
    END IF;
    UPDATE public.event_funnel_confirmation SET state='writing',attempt_token=p_token,payload=c.payload WHERE id=c.id;
    RETURN jsonb_build_object('status','send','payload',c.payload);
  ELSIF p_action='finish' THEN
    IF c.state<>'writing' OR c.attempt_token IS DISTINCT FROM p_token THEN
      RAISE EXCEPTION 'Confirmation attempt changed' USING ERRCODE='PT409';
    END IF;
    IF p_payload->>'outcome' NOT IN ('delivered','not_submitted','unknown') OR p_payload->>'outcome' IS NULL THEN
      RAISE EXCEPTION 'Invalid confirmation result'; END IF;
    UPDATE public.event_funnel_confirmation SET state=CASE p_payload->>'outcome'
      WHEN 'delivered' THEN 'delivered' WHEN 'not_submitted' THEN 'pending' ELSE 'needs_review' END,
      message_id=left(p_payload->>'messageId',500),
      delivered_at=CASE WHEN p_payload->>'outcome'='delivered' THEN clock_timestamp() ELSE NULL END
      WHERE id=c.id;
    RETURN jsonb_build_object('saved',true);
  END IF;
  RAISE EXCEPTION 'Invalid confirmation operation';
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_confirmation_operation(uuid,uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_confirmation_operation(uuid,uuid,uuid,text,uuid,jsonb) TO service_role;
COMMIT;
