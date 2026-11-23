BEGIN;
CREATE TABLE public.event_funnel_cancellation_message(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,order_id uuid NOT NULL,
 reversal_id uuid NOT NULL REFERENCES public.event_funnel_reversal(id),
 booking_source text NOT NULL CHECK(booking_source IN ('booking','complex_event_booking')),booking_id uuid NOT NULL,
 recipient text NOT NULL,booking jsonb NOT NULL,currency text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','writing','delivered','needs_review')),
 payload jsonb,attempt_token uuid,message_id text,
 UNIQUE(reversal_id,booking_source,booking_id,recipient),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
ALTER TABLE public.event_funnel_cancellation_message ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_cancellation_message FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.event_funnel_cancellation_message_operation(
 p_tenant uuid,p_order uuid,p_id uuid,p_lease uuid,p_action text,
 p_message uuid DEFAULT NULL,p_payload jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.event_funnel_order;r public.event_funnel_reversal;c public.event_funnel_cancellation_cleanup;
 m public.event_funnel_cancellation_message;item jsonb;original jsonb;recipient text;jobs jsonb;summary text;
BEGIN
 SELECT * INTO o FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='PT404';END IF;
 SELECT * INTO r FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT r.requires_cleanup OR r.cancelled_at IS NULL OR r.state<>'processing'
   OR r.lease_id IS DISTINCT FROM p_lease OR p_lease IS NULL OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'Cancellation message lease unavailable' USING ERRCODE='PT409';END IF;
 SELECT * INTO c FROM public.event_funnel_cancellation_cleanup WHERE tenant_id=p_tenant AND order_id=p_order AND reversal_id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original approval unavailable' USING ERRCODE='PT409';END IF;
 IF c.snapshot->'authority'->'suppressEmails'='true'::jsonb THEN
   RETURN jsonb_build_object('status','complete','jobs','[]'::jsonb);
 END IF;
 IF p_action='read' THEN
   IF c.snapshot->'authority'->'suppressEmails' IS DISTINCT FROM 'false'::jsonb
     OR o.snapshot->>'currency' !~ '^[A-Z]{3}$' OR o.snapshot->>'currency' IS NULL THEN
     RAISE EXCEPTION 'Original notification authority unavailable' USING ERRCODE='PT409';END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(r.allocations) LOOP
     SELECT registration.value->'row' INTO original FROM jsonb_array_elements(o.snapshot->'lines') line
       CROSS JOIN LATERAL jsonb_array_elements(line.value->'registrations') registration
       WHERE CASE line.value->>'eventKind' WHEN 'simple' THEN 'booking' ELSE 'complex_event_booking' END=item->>'source'
       AND registration.value->>'id'=item->>'id';
     IF original IS NULL THEN RAISE EXCEPTION 'Original recipient evidence missing' USING ERRCODE='PT409';END IF;
     FOR recipient IN SELECT DISTINCT lower(trim(value)) FROM unnest(ARRAY[
       original->>'attendee_email',o.snapshot->'purchaser'->>'email']) value WHERE nullif(trim(value),'') IS NOT NULL LOOP
       IF recipient!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(recipient)>320
         THEN RAISE EXCEPTION 'Original recipient invalid' USING ERRCODE='PT409';END IF;
       INSERT INTO public.event_funnel_cancellation_message(tenant_id,order_id,reversal_id,booking_source,booking_id,recipient,booking,currency)
         VALUES(p_tenant,p_order,p_id,item->>'source',(item->>'id')::uuid,recipient,original,o.snapshot->>'currency')
         ON CONFLICT DO NOTHING;
     END LOOP;
     IF NOT EXISTS(SELECT 1 FROM public.event_funnel_cancellation_message WHERE reversal_id=p_id
       AND booking_source=item->>'source' AND booking_id=(item->>'id')::uuid) THEN
       RAISE EXCEPTION 'No original cancellation recipient' USING ERRCODE='PT409';END IF;
   END LOOP;
 ELSE
   SELECT * INTO m FROM public.event_funnel_cancellation_message WHERE tenant_id=p_tenant AND order_id=p_order
     AND reversal_id=p_id AND id=p_message FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation message unavailable' USING ERRCODE='PT404';END IF;
   IF p_action='begin' THEN
     IF m.state='delivered' THEN RETURN jsonb_build_object('status','complete');END IF;
     IF m.state<>'pending' THEN RETURN jsonb_build_object('status','needs_review');END IF;
     IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text)>131072
       OR p_payload->>'tenantId' IS DISTINCT FROM p_tenant::text OR p_payload->>'to' IS DISTINCT FROM m.recipient
       OR nullif(p_payload->>'subject','') IS NULL OR nullif(p_payload->>'html','') IS NULL
       OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('tenantId','to','subject','html')) THEN
       RAISE EXCEPTION 'Invalid cancellation envelope';END IF;
     UPDATE public.event_funnel_cancellation_message SET payload=coalesce(payload,p_payload),state='writing',attempt_token=p_lease
       WHERE id=m.id RETURNING * INTO m;
     RETURN jsonb_build_object('status','send','payload',m.payload);
   ELSIF p_action='finish' THEN
     IF m.state='delivered' THEN RETURN jsonb_build_object('status','complete');END IF;
     IF m.state<>'writing' OR m.attempt_token IS DISTINCT FROM p_lease THEN
       RAISE EXCEPTION 'Cancellation attempt changed' USING ERRCODE='PT409';END IF;
     IF p_payload->>'outcome' IS NULL OR p_payload->>'outcome' NOT IN ('accepted','not_submitted','unknown')
       THEN RAISE EXCEPTION 'Invalid message outcome';END IF;
     UPDATE public.event_funnel_cancellation_message SET state=CASE p_payload->>'outcome'
       WHEN 'accepted' THEN 'delivered' WHEN 'not_submitted' THEN 'pending' ELSE 'needs_review' END,
       message_id=left(p_payload->>'messageId',500) WHERE id=m.id;
   ELSE RAISE EXCEPTION 'Unknown cancellation message operation';END IF;
 END IF;
 SELECT CASE WHEN count(*) FILTER(WHERE state IN ('writing','needs_review'))>0 THEN 'needs_review'
   WHEN count(*) FILTER(WHERE state='pending')>0 THEN 'retry' ELSE 'complete' END INTO summary
   FROM public.event_funnel_cancellation_message WHERE reversal_id=p_id;
 SELECT coalesce(jsonb_agg(to_jsonb(j)),'[]') INTO jobs FROM
   (SELECT * FROM public.event_funnel_cancellation_message WHERE reversal_id=p_id AND state='pending' ORDER BY id LIMIT 8) j;
 RETURN jsonb_build_object('status',summary,'jobs',jobs);
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_cancellation_message_operation(uuid,uuid,uuid,uuid,text,uuid,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_cancellation_message_operation(uuid,uuid,uuid,uuid,text,uuid,jsonb) TO service_role;
-- Original suppression OR a complete journal; zero messages is not evidence.
DO $$
DECLARE def text;needle text:=$old$IF c.snapshot->'authority'->'suppressEmails' IS DISTINCT FROM 'true'::jsonb THEN$old$;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_cancellation_cleanup_quiet(uuid,uuid,uuid,uuid)'::regprocedure) INTO def;
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected cleanup notification boundary';END IF;
 def:=replace(def,needle,$patch$
 IF c.snapshot->'authority'->'suppressEmails' IS DISTINCT FROM 'true'::jsonb AND (
   NOT EXISTS(SELECT 1 FROM public.event_funnel_cancellation_message WHERE reversal_id=p_id)
   OR EXISTS(SELECT 1 FROM public.event_funnel_cancellation_message WHERE reversal_id=p_id AND state<>'delivered')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.allocations) a WHERE NOT EXISTS(
     SELECT 1 FROM public.event_funnel_cancellation_message m WHERE m.reversal_id=p_id
       AND m.booking_source=a.value->>'source' AND m.booking_id=(a.value->>'id')::uuid))
 ) THEN$patch$);
 needle:=$old$'notifications','suppressed'$old$;
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Unexpected cleanup receipt boundary';END IF;
 EXECUTE replace(def,needle,$patch$'notifications',CASE WHEN c.snapshot->'authority'->'suppressEmails'='true'::jsonb
   THEN 'suppressed' ELSE 'provider_accepted' END$patch$);
END $$;
COMMIT;
