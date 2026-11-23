BEGIN;
-- A confirmed sibling within this checkout can retain shared access. Never
-- infer provider absence, revoke access, or adopt another order's entitlement.
-- The cleanup caller holds this order's row lock, shared with cancellation.
CREATE FUNCTION public.event_funnel_retained_provider_evidence(
 p_tenant uuid,p_order uuid,p_source text,p_booking uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.event_funnel_integration_step;target jsonb;z public.event_funnel_zoom_registration;
 sibling record;status text;retained jsonb;result jsonb:='[]';matched integer:=0;
BEGIN
 SELECT * INTO s FROM public.event_funnel_integration_step WHERE tenant_id=p_tenant AND order_id=p_order
   AND booking_source=p_source AND booking_id=p_booking AND step='providers';
 IF NOT FOUND OR s.state NOT IN ('complete','cancelled') OR jsonb_typeof(s.provider_plan) IS DISTINCT FROM 'array'
   THEN RETURN NULL;END IF;
 IF jsonb_array_length(s.provider_plan)>500 THEN RETURN NULL;END IF;
 IF s.provider_plan='[]'::jsonb THEN
   IF EXISTS(SELECT 1 FROM public.event_funnel_zoom_link WHERE step_id=s.id) THEN RETURN NULL;END IF;
   RETURN result;
 END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(s.provider_plan) LOOP
   SELECT registration.* INTO z FROM public.event_funnel_zoom_registration registration
     JOIN public.event_funnel_zoom_link l ON l.registration_id=registration.id
     WHERE l.step_id=s.id AND registration.tenant_id=p_tenant AND registration.state='ready'
       AND l.verified_at IS NOT NULL AND nullif(registration.registrant_id,'') IS NOT NULL
       AND registration.kind=target->>'kind' AND registration.numeric_id=target->>'numericId'
       AND registration.authority_hash=target->>'authorityHash';
   IF NOT FOUND THEN RETURN NULL;END IF;
   matched:=matched+1;retained:='[]';
   FOR sibling IN SELECT DISTINCT other.booking_source,other.booking_id
     FROM public.event_funnel_zoom_link l JOIN public.event_funnel_integration_step other ON other.id=l.step_id
     JOIN public.event_funnel_order_booking b ON b.tenant_id=other.tenant_id AND b.order_id=other.order_id
       AND b.booking_source=other.booking_source AND b.booking_id=other.booking_id
     WHERE l.registration_id=z.id AND l.verified_at IS NOT NULL AND other.tenant_id=p_tenant
       AND other.order_id=p_order AND other.step='providers' AND other.state='complete'
       AND ROW(other.booking_source,other.booking_id) IS DISTINCT FROM ROW(p_source,p_booking)
     ORDER BY other.booking_source,other.booking_id LOOP
     IF sibling.booking_source NOT IN ('booking','complex_event_booking') THEN RETURN NULL;END IF;
     EXECUTE format('SELECT status FROM public.%I WHERE tenant_id=$1 AND id=$2',sibling.booking_source)
       INTO status USING p_tenant,sibling.booking_id;
     IF status='confirmed' THEN retained:=retained||jsonb_build_array(
       jsonb_build_object('source',sibling.booking_source,'id',sibling.booking_id));END IF;
   END LOOP;
   IF jsonb_array_length(retained)=0 THEN RETURN NULL;END IF;
   result:=result||jsonb_build_array(jsonb_build_object('registrationId',z.id,'retainedFor',retained));
 END LOOP;
 -- An extra link not explained by the frozen plan also requires review.
 IF matched<>(SELECT count(*) FROM public.event_funnel_zoom_link WHERE step_id=s.id)
   OR matched<>(SELECT count(DISTINCT value->>'registrationId') FROM jsonb_array_elements(result)) THEN RETURN NULL;END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_retained_provider_evidence(uuid,uuid,text,uuid)
 FROM PUBLIC,anon,authenticated,service_role;

DO $$
DECLARE def text;anchor text;end_anchor text;start_at integer;end_at integer;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_cancellation_cleanup_quiet(uuid,uuid,uuid,uuid)'::regprocedure) INTO def;
 anchor:='reason text;proof jsonb;';
 IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'Unexpected cleanup declarations';END IF;
 def:=replace(def,anchor,anchor||' provider_proof jsonb;provider_receipts jsonb:=''[]'';');
 anchor:='IF NOT EXISTS(SELECT 1 FROM public.event_funnel_integration_step s WHERE s.tenant_id=p_tenant';
 end_anchor:='OR EXISTS(SELECT 1 FROM jsonb_each(booking) entry';
 start_at:=position(anchor IN def);end_at:=position(end_anchor IN def);
 IF start_at=0 OR end_at<=start_at THEN RAISE EXCEPTION 'Unexpected provider cleanup boundary';END IF;
 def:=overlay(def placing $patch$
 provider_proof:=public.event_funnel_retained_provider_evidence(p_tenant,p_order,source,target_booking);
 IF provider_proof IS NOT NULL THEN
   provider_receipts:=provider_receipts||provider_proof;
 END IF;
 IF provider_proof IS NULL
 $patch$ from start_at for end_at-start_at);
 anchor:=$old$'providers','verified_absent'$old$;
 IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'Unexpected cleanup proof boundary';END IF;
 EXECUTE replace(def,anchor,$patch$'providers',CASE WHEN jsonb_array_length(provider_receipts)=0
   THEN 'verified_absent' ELSE 'retained_for_confirmed_siblings' END,'providerReceipts',provider_receipts$patch$);
END $$;
COMMIT;
