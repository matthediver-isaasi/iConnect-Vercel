BEGIN;
ALTER TABLE public.event_funnel_integration_step ADD COLUMN provider_plan jsonb;
CREATE TABLE public.event_funnel_zoom_registration (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,authority_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('meetings','webinars')),numeric_id text NOT NULL,recipient_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','writing','ready')),
 attempt_token uuid,registrant_id text,updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,authority_hash,kind,numeric_id,recipient_hash)
);
CREATE TABLE public.event_funnel_zoom_link (
 step_id uuid NOT NULL REFERENCES public.event_funnel_integration_step(id),
 registration_id uuid NOT NULL REFERENCES public.event_funnel_zoom_registration(id),
 verified_at timestamptz,
 PRIMARY KEY(step_id,registration_id)
);
ALTER TABLE public.event_funnel_zoom_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_zoom_link ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_zoom_registration,public.event_funnel_zoom_link FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.event_funnel_zoom_operation(
 p_tenant uuid,p_order uuid,p_token uuid,p_step uuid,p_action text,p_id uuid DEFAULT NULL,p_payload jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_integration_step;b jsonb;t jsonb;resource jsonb;event_row jsonb;
 r public.event_funnel_zoom_registration;recipient text;field text;allowed boolean;result jsonb;
BEGIN
 PERFORM 1 FROM public.event_funnel_delivery d JOIN public.event_funnel_order o ON o.id=d.order_id AND o.tenant_id=d.tenant_id
 WHERE d.tenant_id=p_tenant AND d.order_id=p_order AND d.kind='integrations' AND d.state='running'
 AND d.lease_token=p_token AND d.lease_until>clock_timestamp() AND o.state='confirmed' FOR UPDATE OF d;
 IF NOT FOUND THEN RAISE EXCEPTION 'Integration lease unavailable' USING ERRCODE='PT409';END IF;
 SELECT * INTO s FROM public.event_funnel_integration_step WHERE id=p_step AND tenant_id=p_tenant
 AND order_id=p_order AND step='providers' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Provider step unavailable' USING ERRCODE='PT409';END IF;
 EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE tenant_id=$1 AND id=$2',s.booking_source)
 INTO b USING p_tenant,s.booking_id;
 IF b IS NULL OR b->>'status' IS DISTINCT FROM 'confirmed' OR nullif(trim(b->>'attendee_email'),'') IS NULL
 THEN RAISE EXCEPTION 'Registration unavailable' USING ERRCODE='PT409';END IF;
 recipient:=encode(sha256(convert_to(lower(trim(b->>'attendee_email')),'UTF8')),'hex');
 IF p_action='plan' THEN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload)>500
  THEN RAISE EXCEPTION 'Invalid provider plan';END IF;
  IF s.provider_plan IS NOT NULL AND s.provider_plan IS DISTINCT FROM p_payload
  THEN RAISE EXCEPTION 'Provider authority changed' USING ERRCODE='PT409';END IF;
  EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE tenant_id=$1 AND id=$2',
    CASE s.booking_source WHEN 'booking' THEN 'event' ELSE 'complex_event' END)
  INTO event_row USING p_tenant,(b->>'event_id')::uuid;
  IF event_row IS NULL THEN RAISE EXCEPTION 'Event unavailable';END IF;
  FOR t IN SELECT value FROM jsonb_array_elements(p_payload) ORDER BY value->>'kind',value->>'numericId' LOOP
   IF t->>'kind' NOT IN ('meetings','webinars') OR t->>'kind' IS NULL
     OR coalesce(t->>'authorityHash','') !~ '^[a-f0-9]{64}$' OR coalesce(t->>'numericId','') !~ '^[0-9]{6,20}$'
   THEN RAISE EXCEPTION 'Invalid provider target';END IF;
   field:=CASE t->>'kind' WHEN 'meetings' THEN 'zoom_meeting_id' ELSE 'zoom_webinar_id' END;
   EXECUTE format('SELECT to_jsonb(z) FROM public.%I z WHERE tenant_id=$1 AND id=$2',
     CASE t->>'kind' WHEN 'meetings' THEN 'zoom_meeting' ELSE 'zoom_webinar' END)
   INTO resource USING p_tenant,(t->>'localId')::uuid;
   IF resource IS NULL OR resource->>field IS DISTINCT FROM t->>'numericId'
   THEN RAISE EXCEPTION 'Provider resource changed' USING ERRCODE='PT409';END IF;
   allowed:=event_row->>field=t->>'localId';
   IF NOT coalesce(allowed,false) THEN
    IF s.booking_source='booking' THEN
     SELECT EXISTS(SELECT 1 FROM public.event_agenda_item a WHERE a.event_id=(b->>'event_id')::uuid
       AND to_jsonb(a)->>field=t->>'localId') INTO allowed;
    ELSE
     SELECT EXISTS(SELECT 1 FROM public.complex_event_session c WHERE c.tenant_id=p_tenant
       AND c.complex_event_id=(b->>'event_id')::uuid AND to_jsonb(c)->>field=t->>'localId') INTO allowed;
    END IF;
   END IF;
   IF NOT coalesce(allowed,false) THEN RAISE EXCEPTION 'Unrelated provider resource';END IF;
   INSERT INTO public.event_funnel_zoom_registration(tenant_id,authority_hash,kind,numeric_id,recipient_hash)
    VALUES(p_tenant,t->>'authorityHash',t->>'kind',t->>'numericId',recipient) ON CONFLICT DO NOTHING;
   SELECT * INTO r FROM public.event_funnel_zoom_registration WHERE tenant_id=p_tenant
     AND authority_hash=t->>'authorityHash' AND kind=t->>'kind' AND numeric_id=t->>'numericId' AND recipient_hash=recipient;
   INSERT INTO public.event_funnel_zoom_link(step_id,registration_id) VALUES(s.id,r.id) ON CONFLICT DO NOTHING;
  END LOOP;
  UPDATE public.event_funnel_integration_step SET provider_plan=p_payload WHERE id=s.id;
 ELSIF p_action IN ('begin','observed','not_submitted') THEN
  SELECT z.* INTO r FROM public.event_funnel_zoom_registration z JOIN public.event_funnel_zoom_link l
    ON l.registration_id=z.id WHERE l.step_id=s.id AND z.id=p_id AND z.tenant_id=p_tenant FOR UPDATE OF z;
  IF NOT FOUND OR r.recipient_hash<>recipient THEN RAISE EXCEPTION 'Provider recipient changed' USING ERRCODE='PT409';END IF;
  IF p_action='begin' THEN
   IF r.state<>'pending' THEN RETURN jsonb_build_object('write',false);END IF;
   UPDATE public.event_funnel_zoom_registration SET state='writing',attempt_token=p_token,updated_at=clock_timestamp() WHERE id=r.id;
   RETURN jsonb_build_object('write',true);
  ELSIF p_action='observed' THEN
   -- Only the server adapter may attest approved or explicitly unnecessary registration.
   IF p_payload->>'outcome' NOT IN ('approved','not_required') OR p_payload->>'outcome' IS NULL
     OR (p_payload->>'outcome'='approved' AND nullif(p_payload->>'registrantId','') IS NULL)
     OR length(p_payload->>'registrantId')>300
   THEN RAISE EXCEPTION 'Invalid provider receipt';END IF;
   UPDATE public.event_funnel_zoom_registration SET state='ready',registrant_id=p_payload->>'registrantId',
     attempt_token=NULL,updated_at=clock_timestamp() WHERE id=r.id;
   UPDATE public.event_funnel_zoom_link SET verified_at=clock_timestamp() WHERE step_id=s.id AND registration_id=r.id;
  ELSE
   UPDATE public.event_funnel_zoom_registration SET state='pending',attempt_token=NULL,updated_at=clock_timestamp()
     WHERE id=r.id AND state='writing' AND attempt_token=p_token;
  END IF;
 ELSIF p_action IS DISTINCT FROM 'read' THEN RAISE EXCEPTION 'Unknown provider action';END IF;
 IF EXISTS(SELECT 1 FROM public.event_funnel_zoom_link l JOIN public.event_funnel_zoom_registration z ON z.id=l.registration_id
   WHERE l.step_id=s.id AND z.recipient_hash<>recipient) THEN RAISE EXCEPTION 'Provider recipient changed' USING ERRCODE='PT409';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') INTO result FROM (
  SELECT z.* FROM public.event_funnel_zoom_link l JOIN public.event_funnel_zoom_registration z ON z.id=l.registration_id
  WHERE l.step_id=s.id AND l.verified_at IS NULL ORDER BY CASE z.state WHEN 'pending' THEN 0 ELSE 1 END,z.updated_at,z.id LIMIT 4) q;
 UPDATE public.event_funnel_zoom_registration SET updated_at=clock_timestamp()
 WHERE id IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(result));
 RETURN jsonb_build_object('jobs',result,'ready',s.provider_plan IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.event_funnel_zoom_link l JOIN public.event_funnel_zoom_registration z ON z.id=l.registration_id
  WHERE l.step_id=s.id AND (z.state<>'ready' OR l.verified_at IS NULL)));
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_zoom_operation(uuid,uuid,uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_zoom_operation(uuid,uuid,uuid,uuid,text,uuid,jsonb) TO service_role;
CREATE FUNCTION public.event_funnel_provider_completion_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.provider_plan IS NULL OR EXISTS(SELECT 1 FROM public.event_funnel_zoom_link l
   JOIN public.event_funnel_zoom_registration z ON z.id=l.registration_id
   WHERE l.step_id=NEW.id AND (z.state<>'ready' OR l.verified_at IS NULL)) THEN
   RAISE EXCEPTION 'Provider preparation incomplete' USING ERRCODE='PT409';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_provider_completion_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER event_funnel_provider_completion_guard BEFORE UPDATE OF state ON public.event_funnel_integration_step
 FOR EACH ROW WHEN(NEW.step='providers' AND NEW.state='complete' AND OLD.state IS DISTINCT FROM 'complete')
 EXECUTE FUNCTION public.event_funnel_provider_completion_guard();
COMMIT;
