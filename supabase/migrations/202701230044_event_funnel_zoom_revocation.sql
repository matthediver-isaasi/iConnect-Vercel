BEGIN;
ALTER TABLE public.event_funnel_zoom_registration
 ADD COLUMN access_epoch uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN access_state text NOT NULL DEFAULT 'active' CHECK(access_state IN ('active','revoking','revoked')),
 ADD COLUMN ownership text NOT NULL DEFAULT 'unknown' CHECK(ownership IN ('unknown','external','funnel'));
ALTER TABLE public.event_funnel_zoom_link ADD COLUMN access_epoch uuid;
UPDATE public.event_funnel_zoom_link l SET access_epoch=z.access_epoch
 FROM public.event_funnel_zoom_registration z WHERE z.id=l.registration_id;
ALTER TABLE public.event_funnel_zoom_link ALTER COLUMN access_epoch SET NOT NULL;
CREATE INDEX event_funnel_zoom_recipient ON public.event_funnel_zoom_registration(tenant_id,recipient_hash,id);
CREATE TABLE public.event_funnel_zoom_revocation(
 registration_id uuid NOT NULL REFERENCES public.event_funnel_zoom_registration(id),access_epoch uuid NOT NULL,
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,reversal_id uuid NOT NULL REFERENCES public.event_funnel_reversal(id),
 snapshot jsonb NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','writing','complete')),
 receipt jsonb,PRIMARY KEY(registration_id,access_epoch),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
ALTER TABLE public.event_funnel_zoom_revocation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_zoom_revocation FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.event_funnel_zoom_booking_uses_resource(
 p_tenant uuid,p_source text,p_booking jsonb,p_registration uuid,p_kind text,p_numeric text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE event_row jsonb;resource record;field text;source_table text;found_target boolean;
BEGIN
 IF p_source NOT IN ('booking','complex_event_booking') OR p_kind NOT IN ('meetings','webinars')
   OR p_source IS NULL OR p_kind IS NULL THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM public.event_funnel_zoom_link l JOIN public.event_funnel_integration_step s ON s.id=l.step_id
   JOIN public.event_funnel_zoom_registration z ON z.id=l.registration_id AND z.access_epoch=l.access_epoch
   WHERE s.tenant_id=p_tenant AND s.booking_source=p_source AND s.booking_id=(p_booking->>'id')::uuid
     AND z.id=p_registration) THEN RETURN true;END IF;
 field:=CASE p_kind WHEN 'meetings' THEN 'zoom_meeting_id' ELSE 'zoom_webinar_id' END;
 source_table:=CASE p_source WHEN 'booking' THEN 'event' ELSE 'complex_event' END;
 EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE tenant_id=$1 AND id=$2',source_table)
   INTO event_row USING p_tenant,(p_booking->>'event_id')::uuid;
 IF event_row IS NULL THEN RETURN false;END IF;
 FOR resource IN EXECUTE format('SELECT id FROM public.%I WHERE tenant_id=$1 AND %I::text=$2',
   CASE p_kind WHEN 'meetings' THEN 'zoom_meeting' ELSE 'zoom_webinar' END,field) USING p_tenant,p_numeric LOOP
   IF event_row->>field=resource.id::text OR p_booking->>field IN (resource.id::text,p_numeric) THEN RETURN true;END IF;
   IF p_source='booking' THEN
     SELECT EXISTS(SELECT 1 FROM public.event_agenda_item a WHERE a.event_id=(p_booking->>'event_id')::uuid
       AND to_jsonb(a)->>field=resource.id::text) INTO found_target;
   ELSE
     SELECT EXISTS(SELECT 1 FROM public.complex_event_session a WHERE a.tenant_id=p_tenant
       AND a.complex_event_id=(p_booking->>'event_id')::uuid AND to_jsonb(a)->>field=resource.id::text) INTO found_target;
   END IF;
   IF found_target THEN RETURN true;END IF;
 END LOOP;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_zoom_booking_uses_resource(uuid,text,jsonb,uuid,text,text)
 FROM PUBLIC,anon,authenticated,service_role;

-- New ordinary and funnel entitlements share the provider row lock with
-- revocation admission. An unresolved external write cannot grant fresh access.
CREATE FUNCTION public.event_funnel_zoom_entitlement_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE z record;
BEGIN
 IF NEW.status='confirmed' AND nullif(trim(to_jsonb(NEW)->>'attendee_email'),'') IS NOT NULL THEN
   FOR z IN SELECT id,access_state,kind,numeric_id FROM public.event_funnel_zoom_registration
     WHERE tenant_id=NEW.tenant_id AND recipient_hash=encode(sha256(convert_to(
       lower(trim(to_jsonb(NEW)->>'attendee_email')),'UTF8')),'hex') ORDER BY id FOR UPDATE LOOP
     IF z.access_state='revoking' AND public.event_funnel_zoom_booking_uses_resource(
       NEW.tenant_id,TG_TABLE_NAME,to_jsonb(NEW),z.id,z.kind,z.numeric_id) THEN
       RAISE EXCEPTION 'Provider access reconciliation pending' USING ERRCODE='PT409';END IF;
   END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_zoom_entitlement_guard BEFORE INSERT OR UPDATE OF status,attendee_email ON public.booking
 FOR EACH ROW EXECUTE FUNCTION public.event_funnel_zoom_entitlement_guard();
CREATE TRIGGER event_funnel_zoom_entitlement_guard BEFORE INSERT OR UPDATE OF status,attendee_email ON public.complex_event_booking
 FOR EACH ROW EXECUTE FUNCTION public.event_funnel_zoom_entitlement_guard();
REVOKE ALL ON FUNCTION public.event_funnel_zoom_entitlement_guard() FROM PUBLIC,anon,authenticated,service_role;

DO $$
DECLARE def text;anchor text;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_zoom_operation(uuid,uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure) INTO def;
 anchor:='AND recipient_hash=recipient;';
 IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'Unexpected Zoom identity boundary';END IF;
 def:=replace(def,anchor,$patch$AND recipient_hash=recipient FOR UPDATE;
    IF r.access_state='revoking' THEN RAISE EXCEPTION 'Provider revocation pending' USING ERRCODE='PT409';END IF;
    IF r.access_state='revoked' THEN
      UPDATE public.event_funnel_zoom_registration SET access_epoch=gen_random_uuid(),access_state='active',
        ownership='unknown',state='pending',registrant_id=NULL,attempt_token=NULL WHERE id=r.id RETURNING * INTO r;
    END IF;$patch$);
 anchor:='INSERT INTO public.event_funnel_zoom_link(step_id,registration_id) VALUES(s.id,r.id) ON CONFLICT DO NOTHING;';
 IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'Unexpected Zoom link boundary';END IF;
 def:=replace(def,anchor,'INSERT INTO public.event_funnel_zoom_link(step_id,registration_id,access_epoch) VALUES(s.id,r.id,r.access_epoch) ON CONFLICT DO NOTHING;');
 def:=replace(def,'ON l.registration_id=z.id','ON l.registration_id=z.id AND l.access_epoch=z.access_epoch');
 def:=replace(def,'ON z.id=l.registration_id','ON z.id=l.registration_id AND l.access_epoch=z.access_epoch');
 anchor:='IF p_action=''begin'' THEN';
 IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'Unexpected Zoom admission boundary';END IF;
 def:=replace(def,anchor,$patch$
 IF r.access_state<>'active' THEN RAISE EXCEPTION 'Provider grant no longer active' USING ERRCODE='PT409';END IF;
 $patch$||anchor);
 anchor:='SET state=''writing'',attempt_token=p_token';
 IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'Unexpected Zoom ownership boundary';END IF;
 def:=replace(def,anchor,'SET ownership=''funnel'',state=''writing'',attempt_token=p_token');
 anchor:='SET state=''ready'',registrant_id=p_payload->>''registrantId'',';
 IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'Unexpected Zoom receipt boundary';END IF;
 EXECUTE replace(def,anchor,$patch$SET ownership=CASE WHEN ownership='unknown' AND state='pending'
   THEN 'external' ELSE ownership END,state='ready',registrant_id=p_payload->>'registrantId',$patch$);
 SELECT pg_get_functiondef('public.event_funnel_zoom_operation(uuid,uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure) INTO def;
 anchor:='SET state=''pending'',attempt_token=NULL,updated_at=clock_timestamp()';
 IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'Unexpected known non-submission boundary';END IF;
 EXECUTE replace(def,anchor,'SET ownership=''unknown'',state=''pending'',attempt_token=NULL,updated_at=clock_timestamp()');
END $$;

CREATE FUNCTION public.event_funnel_zoom_revoke(
 p_tenant uuid,p_order uuid,p_reversal uuid,p_lease uuid,p_action text,p_registration uuid DEFAULT NULL,p_epoch uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_reversal;z public.event_funnel_zoom_registration;link record;other record;
 j public.event_funnel_zoom_revocation;shared boolean;rows jsonb:='[]';email text;
BEGIN
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 SELECT * INTO r FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_reversal FOR UPDATE;
 IF NOT FOUND OR r.cancelled_at IS NULL OR NOT r.requires_cleanup OR r.state<>'processing'
   OR p_lease IS NULL OR r.lease_id IS DISTINCT FROM p_lease OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp()
   THEN RAISE EXCEPTION 'Revocation lease unavailable' USING ERRCODE='PT409';END IF;
 IF p_action NOT IN ('read','begin','complete') OR p_action IS NULL THEN RAISE EXCEPTION 'Invalid revocation action';END IF;
 FOR link IN SELECT DISTINCT l.registration_id,l.access_epoch
   FROM public.event_funnel_zoom_link l JOIN public.event_funnel_integration_step s ON s.id=l.step_id
   JOIN jsonb_array_elements(r.allocations) a ON a.value->>'source'=s.booking_source AND (a.value->>'id')::uuid=s.booking_id
   WHERE s.tenant_id=p_tenant AND s.order_id=p_order
   AND (p_action='read' OR (l.registration_id=p_registration AND l.access_epoch=p_epoch))
   ORDER BY l.registration_id,l.access_epoch LOOP
   SELECT * INTO z FROM public.event_funnel_zoom_registration WHERE id=link.registration_id AND tenant_id=p_tenant FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original provider registration missing' USING ERRCODE='PT409';END IF;
   SELECT * INTO j FROM public.event_funnel_zoom_revocation WHERE registration_id=z.id AND access_epoch=link.access_epoch;
   IF j.state='complete' THEN
     rows:=rows||jsonb_build_array(jsonb_build_object('status','complete','id',z.id,'epoch',link.access_epoch));CONTINUE;
   END IF;
   IF link.access_epoch<>z.access_epoch THEN RAISE EXCEPTION 'Unreconciled historical access' USING ERRCODE='PT409';END IF;
   -- Preserve every current entitlement, including ordinary bookings. This
   -- deliberately errs toward retaining access for another active registration.
   shared:=false;
   FOR other IN SELECT 'booking' source,id FROM public.booking WHERE tenant_id=p_tenant AND status='confirmed'
       AND encode(sha256(convert_to(lower(trim(to_jsonb(booking)->>'attendee_email')),'UTF8')),'hex')=z.recipient_hash
       AND public.event_funnel_zoom_booking_uses_resource(p_tenant,'booking',to_jsonb(booking),z.id,z.kind,z.numeric_id)
     UNION ALL SELECT 'complex_event_booking',id FROM public.complex_event_booking WHERE tenant_id=p_tenant AND status='confirmed'
       AND encode(sha256(convert_to(lower(trim(to_jsonb(complex_event_booking)->>'attendee_email')),'UTF8')),'hex')=z.recipient_hash
       AND public.event_funnel_zoom_booking_uses_resource(p_tenant,'complex_event_booking',to_jsonb(complex_event_booking),
         z.id,z.kind,z.numeric_id) LOOP
     shared:=true;
   END LOOP;
   IF shared AND z.access_state='active' THEN
     rows:=rows||jsonb_build_array(jsonb_build_object('status','retained','id',z.id,'epoch',z.access_epoch));CONTINUE;
   END IF;
   IF z.ownership='external' AND z.access_state='active' THEN
     rows:=rows||jsonb_build_array(jsonb_build_object('status','external','id',z.id,'epoch',z.access_epoch));CONTINUE;
   END IF;
   IF z.ownership<>'funnel' OR z.state<>'ready' OR nullif(z.registrant_id,'') IS NULL THEN
     rows:=rows||jsonb_build_array(jsonb_build_object('status','needs_review','id',z.id,'epoch',z.access_epoch));CONTINUE;
   END IF;
   SELECT lower(trim(original.value->'row'->>'attendee_email')) INTO email
     FROM public.event_funnel_order o CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'lines') line
     CROSS JOIN LATERAL jsonb_array_elements(line.value->'registrations') original
     JOIN jsonb_array_elements(r.allocations) a ON original.value->>'id'=a.value->>'id'
     WHERE o.tenant_id=p_tenant AND o.id=p_order AND
       encode(sha256(convert_to(lower(trim(original.value->'row'->>'attendee_email')),'UTF8')),'hex')=z.recipient_hash LIMIT 1;
   IF email IS NULL THEN RAISE EXCEPTION 'Original provider recipient missing' USING ERRCODE='PT409';END IF;
   INSERT INTO public.event_funnel_zoom_revocation(registration_id,access_epoch,tenant_id,order_id,reversal_id,snapshot)
     VALUES(z.id,z.access_epoch,p_tenant,p_order,p_reversal,jsonb_build_object('kind',z.kind,'numericId',z.numeric_id,
       'authorityHash',z.authority_hash,'registrantId',z.registrant_id,'email',email)) ON CONFLICT DO NOTHING;
   SELECT * INTO j FROM public.event_funnel_zoom_revocation WHERE registration_id=z.id AND access_epoch=z.access_epoch FOR UPDATE;
   IF j.reversal_id<>p_reversal THEN
     rows:=rows||jsonb_build_array(jsonb_build_object('status','needs_review','id',z.id,'epoch',z.access_epoch));CONTINUE;END IF;
   IF p_action='begin' AND j.state='pending' THEN
     UPDATE public.event_funnel_zoom_registration SET access_state='revoking' WHERE id=z.id;
     UPDATE public.event_funnel_zoom_revocation SET state='writing' WHERE registration_id=z.id AND access_epoch=z.access_epoch;
     RETURN jsonb_build_object('write',true);
   ELSIF p_action='complete' AND j.state='writing' THEN
     UPDATE public.event_funnel_zoom_registration SET access_state='revoked' WHERE id=z.id;
     UPDATE public.event_funnel_zoom_revocation SET state='complete',receipt=jsonb_build_object('revokedAt',clock_timestamp(),
       'registrantId',z.registrant_id) WHERE registration_id=z.id AND access_epoch=z.access_epoch;
     RETURN jsonb_build_object('status','complete');
   END IF;
   rows:=rows||jsonb_build_array(to_jsonb(j)||jsonb_build_object('id',z.id,'epoch',z.access_epoch,'status',j.state));
 END LOOP;
 IF p_action='begin' THEN RETURN jsonb_build_object('write',false);END IF;
 IF p_action='complete' THEN RAISE EXCEPTION 'Revocation evidence unavailable' USING ERRCODE='PT409';END IF;
 RETURN jsonb_build_object('jobs',rows);
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_zoom_revoke(uuid,uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_zoom_revoke(uuid,uuid,uuid,uuid,text,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.event_funnel_retained_provider_evidence(
 p_tenant uuid,p_order uuid,p_source text,p_booking uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_integration_step;target jsonb;link record;other record;
 result jsonb:='[]';retained jsonb;status text;matched integer:=0;
BEGIN
 SELECT * INTO s FROM public.event_funnel_integration_step WHERE tenant_id=p_tenant AND order_id=p_order
   AND booking_source=p_source AND booking_id=p_booking AND step='providers';
 IF NOT FOUND OR s.state NOT IN ('complete','cancelled') OR jsonb_typeof(s.provider_plan) IS DISTINCT FROM 'array'
   OR jsonb_array_length(s.provider_plan)>500 THEN RETURN NULL;END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(s.provider_plan) LOOP
   SELECT z.*,l.access_epoch link_epoch,l.verified_at,j.state revoke_state INTO link
     FROM public.event_funnel_zoom_registration z JOIN public.event_funnel_zoom_link l ON l.registration_id=z.id
     LEFT JOIN public.event_funnel_zoom_revocation j ON j.registration_id=z.id AND j.access_epoch=l.access_epoch
     WHERE l.step_id=s.id AND z.tenant_id=p_tenant AND z.kind=target->>'kind'
       AND z.numeric_id=target->>'numericId' AND z.authority_hash=target->>'authorityHash';
   IF NOT FOUND THEN RETURN NULL;END IF;
   matched:=matched+1;
   IF link.revoke_state='complete' THEN
     result:=result||jsonb_build_array(jsonb_build_object('registrationId',link.id,'epoch',link.link_epoch,'revoked',true));
     CONTINUE;
   END IF;
   IF link.access_epoch<>link.link_epoch OR link.access_state<>'active' OR link.state<>'ready'
     OR link.verified_at IS NULL THEN RETURN NULL;END IF;
   IF link.ownership='external' THEN
     result:=result||jsonb_build_array(jsonb_build_object('registrationId',link.id,'externalAccessRetained',true));CONTINUE;END IF;
   retained:='[]';
   FOR other IN SELECT DISTINCT provider.booking_source,provider.booking_id
     FROM public.event_funnel_zoom_link l JOIN public.event_funnel_integration_step provider ON provider.id=l.step_id
     WHERE l.registration_id=link.id AND l.access_epoch=link.access_epoch AND l.verified_at IS NOT NULL
       AND provider.tenant_id=p_tenant AND provider.state='complete'
       AND ROW(provider.booking_source,provider.booking_id) IS DISTINCT FROM ROW(p_source,p_booking) LOOP
     EXECUTE format('SELECT status FROM public.%I WHERE tenant_id=$1 AND id=$2',other.booking_source)
       INTO status USING p_tenant,other.booking_id;
     IF status='confirmed' THEN retained:=retained||jsonb_build_array(
       jsonb_build_object('source',other.booking_source,'id',other.booking_id));END IF;
   END LOOP;
   -- Ordinary bookings and other checkouts can own the same provider access.
   -- Revocation admission and new confirmed entitlements share the provider
   -- row lock; the last cancellation, not an earlier one, removes that access.
   FOR other IN SELECT 'booking' source,b.id FROM public.booking b WHERE b.tenant_id=p_tenant AND b.status='confirmed'
       AND encode(sha256(convert_to(lower(trim(to_jsonb(b)->>'attendee_email')),'UTF8')),'hex')=link.recipient_hash
       AND public.event_funnel_zoom_booking_uses_resource(p_tenant,'booking',to_jsonb(b),link.id,link.kind,link.numeric_id)
       AND NOT EXISTS(SELECT 1 FROM public.event_funnel_order_booking owned WHERE owned.tenant_id=p_tenant
         AND owned.booking_source='booking' AND owned.booking_id=b.id)
     UNION ALL SELECT 'complex_event_booking',b.id FROM public.complex_event_booking b
       WHERE b.tenant_id=p_tenant AND b.status='confirmed'
       AND encode(sha256(convert_to(lower(trim(to_jsonb(b)->>'attendee_email')),'UTF8')),'hex')=link.recipient_hash
       AND public.event_funnel_zoom_booking_uses_resource(p_tenant,'complex_event_booking',to_jsonb(b),link.id,link.kind,link.numeric_id)
       AND NOT EXISTS(SELECT 1 FROM public.event_funnel_order_booking owned WHERE owned.tenant_id=p_tenant
         AND owned.booking_source='complex_event_booking' AND owned.booking_id=b.id) LOOP
     -- Funnel bookings require the verified provider link above; standalone
     -- records retain their existing event-owned entitlement.
     IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained) a WHERE a.value->>'source'=other.source
       AND a.value->>'id'=other.id::text) THEN
       retained:=retained||jsonb_build_array(jsonb_build_object('source',other.source,'id',other.id));
     END IF;
   END LOOP;
   IF retained='[]'::jsonb THEN RETURN NULL;END IF;
   result:=result||jsonb_build_array(jsonb_build_object('registrationId',link.id,'retainedFor',retained));
 END LOOP;
 IF matched<>(SELECT count(*) FROM public.event_funnel_zoom_link WHERE step_id=s.id)
   OR matched<>(SELECT count(DISTINCT value->>'registrationId') FROM jsonb_array_elements(result)) THEN RETURN NULL;END IF;
 RETURN result;
END $$;
-- Receipt wording covers absence, verified retention and actual revocation.
DO $$
DECLARE def text;anchor text:=$old$THEN 'verified_absent' ELSE 'retained_for_confirmed_siblings' END$old$;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_cancellation_cleanup_quiet(uuid,uuid,uuid,uuid)'::regprocedure) INTO def;
 IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'Unexpected provider receipt baseline';END IF;
 EXECUTE replace(def,anchor,$patch$THEN 'verified_absent' ELSE 'verified_provider_cleanup' END$patch$);
END $$;
COMMIT;
