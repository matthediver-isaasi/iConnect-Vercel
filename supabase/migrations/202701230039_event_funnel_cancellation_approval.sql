BEGIN;
ALTER TABLE public.event_funnel_reversal ADD COLUMN requires_cleanup boolean NOT NULL DEFAULT false;
CREATE TABLE public.event_funnel_cancellation_approval(
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,order_id uuid NOT NULL,
 reversal_id uuid NOT NULL REFERENCES public.event_funnel_reversal(id),
 authority jsonb NOT NULL,approval_xid bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
CREATE INDEX event_funnel_cancellation_approval_operation ON public.event_funnel_cancellation_approval(reversal_id);
CREATE TABLE public.event_funnel_cancellation_cleanup(
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,
 reversal_id uuid PRIMARY KEY REFERENCES public.event_funnel_reversal(id),
 snapshot jsonb NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','needs_review','complete')),
 receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id),
 CHECK(state<>'complete' OR jsonb_typeof(receipt) IS NOT DISTINCT FROM 'object')
);
ALTER TABLE public.event_funnel_cancellation_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_cancellation_cleanup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_cancellation_approval,public.event_funnel_cancellation_cleanup
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.event_funnel_cancellation_request_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE binding public.event_funnel_cancellation_approval;owned boolean;
BEGIN
 IF TG_OP<>'INSERT' THEN
   SELECT * INTO binding FROM public.event_funnel_cancellation_approval WHERE tenant_id=OLD.tenant_id AND request_id=OLD.id;
   IF binding.request_id IS NOT NULL THEN
     IF TG_OP='DELETE' THEN
       IF EXISTS(SELECT 1 FROM public.event_funnel_reversal WHERE id=binding.reversal_id AND state='complete') THEN RETURN OLD;END IF;
       RAISE EXCEPTION 'Cancellation recovery is not complete' USING ERRCODE='PT409';
     END IF;
     IF to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW;END IF;
     IF binding.approval_xid=txid_current() AND OLD.status='pending' AND NEW.status='approved'
       AND ROW(OLD.tenant_id,OLD.booking_id,coalesce(OLD.booking_source,'booking'))
         IS NOT DISTINCT FROM ROW(NEW.tenant_id,NEW.booking_id,coalesce(NEW.booking_source,'booking')) THEN RETURN NEW;END IF;
     RAISE EXCEPTION 'Approved cancellation authority cannot change' USING ERRCODE='PT409';
   END IF;
   SELECT EXISTS(SELECT 1 FROM public.event_funnel_order_booking WHERE tenant_id=OLD.tenant_id
     AND booking_source=coalesce(OLD.booking_source,'booking') AND booking_id=OLD.booking_id) INTO owned;
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 END IF;
 owned:=coalesce(owned,false) OR EXISTS(SELECT 1 FROM public.event_funnel_order_booking WHERE tenant_id=NEW.tenant_id
   AND booking_source=coalesce(NEW.booking_source,'booking') AND booking_id=NEW.booking_id);
 IF owned THEN
   IF TG_OP='INSERT' AND NEW.status IS DISTINCT FROM 'pending' THEN
     RAISE EXCEPTION 'A shared checkout cancellation must start pending' USING ERRCODE='PT409';
   ELSIF TG_OP='UPDATE' AND (NEW.status='approved'
     OR ROW(OLD.tenant_id,OLD.booking_id,coalesce(OLD.booking_source,'booking'))
       IS DISTINCT FROM ROW(NEW.tenant_id,NEW.booking_id,coalesce(NEW.booking_source,'booking'))) THEN
     RAISE EXCEPTION 'Shared checkout cancellation requires atomic approval' USING ERRCODE='PT409';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_cancellation_request_guard BEFORE INSERT OR UPDATE OR DELETE ON public.booking_cancellation_request
 FOR EACH ROW EXECUTE FUNCTION public.event_funnel_cancellation_request_guard();
REVOKE ALL ON FUNCTION public.event_funnel_cancellation_request_guard() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.event_funnel_approve_cancellation(
 p_tenant uuid,p_order uuid,p_id uuid,p_requests uuid[],p_items jsonb,p_options jsonb,p_authority jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request public.booking_cancellation_request; binding public.event_funnel_cancellation_approval;
 authority jsonb;targets jsonb:='[]';counted integer:=0;bound integer:=0;result jsonb;
BEGIN
 IF p_tenant IS NULL OR p_order IS NULL OR p_id IS NULL OR p_requests IS NULL
   OR cardinality(p_requests) NOT BETWEEN 1 AND 1000 OR array_position(p_requests,NULL) IS NOT NULL
   OR (SELECT count(*)<>count(DISTINCT value) FROM unnest(p_requests) value)
   OR jsonb_typeof(p_authority) IS DISTINCT FROM 'object' OR octet_length(p_authority::text)>16384
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_authority) k
     WHERE k NOT IN ('actor','reviewer','reviewNotes','suppressEmails','creditNoteEmail'))
   OR coalesce(p_authority->>'actor','')!~'^(user|member):[0-9a-fA-F-]{36}$'
   OR jsonb_typeof(p_authority->'reviewer') IS DISTINCT FROM 'string'
   OR length(p_authority->>'reviewer') NOT BETWEEN 1 AND 200
   OR jsonb_typeof(p_authority->'suppressEmails') IS DISTINCT FROM 'boolean'
   OR (p_authority->'reviewNotes' IS NOT NULL AND p_authority->'reviewNotes'<>'null'
     AND (jsonb_typeof(p_authority->'reviewNotes')<>'string' OR length(p_authority->>'reviewNotes')>4000))
   OR (p_authority->'creditNoteEmail' IS NOT NULL AND p_authority->'creditNoteEmail'<>'null'
     AND (jsonb_typeof(p_authority->'creditNoteEmail')<>'string' OR length(p_authority->>'creditNoteEmail')>320
       OR p_authority->>'creditNoteEmail'!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')) THEN
   RAISE EXCEPTION 'Invalid cancellation approval' USING ERRCODE='22023';
 END IF;
 PERFORM substring(p_authority->>'actor' FROM position(':' IN p_authority->>'actor')+1)::uuid;
 authority:=jsonb_build_object('actor',p_authority->>'actor','reviewer',p_authority->>'reviewer',
   'reviewNotes',p_authority->'reviewNotes','suppressEmails',p_authority->'suppressEmails','creditNoteEmail',p_authority->'creditNoteEmail');
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Checkout unavailable' USING ERRCODE='PT404';END IF;
 FOR request IN SELECT * FROM public.booking_cancellation_request
   WHERE tenant_id=p_tenant AND id=ANY(p_requests) ORDER BY id FOR UPDATE LOOP
   counted:=counted+1;
   IF NOT EXISTS(SELECT 1 FROM public.event_funnel_order_booking WHERE tenant_id=p_tenant AND order_id=p_order
     AND booking_source=coalesce(request.booking_source,'booking') AND booking_id=request.booking_id) THEN
     RAISE EXCEPTION 'Cancellation request belongs to another checkout' USING ERRCODE='PT409';
   END IF;
   targets:=targets||jsonb_build_array(jsonb_build_object('source',coalesce(request.booking_source,'booking'),'id',request.booking_id));
   SELECT * INTO binding FROM public.event_funnel_cancellation_approval WHERE tenant_id=p_tenant AND request_id=request.id;
   IF FOUND THEN
     IF binding.reversal_id<>p_id OR binding.order_id<>p_order OR binding.authority<>authority OR request.status<>'approved' THEN
       RAISE EXCEPTION 'Cancellation request already reviewed' USING ERRCODE='PT409';
     END IF;
     bound:=bound+1;
   ELSIF request.status IS DISTINCT FROM 'pending' THEN
     RAISE EXCEPTION 'Cancellation request already reviewed' USING ERRCODE='PT409';
   END IF;
 END LOOP;
 IF counted<>cardinality(p_requests) THEN RAISE EXCEPTION 'Cancellation request unavailable' USING ERRCODE='PT404';END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)<>counted
   OR (SELECT count(*)<>count(DISTINCT (value->>'source',value->>'id')) FROM jsonb_array_elements(targets))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) i WHERE NOT EXISTS(
     SELECT 1 FROM jsonb_array_elements(targets) t WHERE t->>'source'=i->>'source' AND (t->>'id')::uuid=(i->>'id')::uuid)) THEN
   RAISE EXCEPTION 'Refund allocations differ from the reviewed requests' USING ERRCODE='PT409';
 END IF;
 IF bound>0 THEN
   IF bound<>counted OR (SELECT count(*) FROM public.event_funnel_cancellation_approval WHERE reversal_id=p_id)<>counted THEN
     RAISE EXCEPTION 'Cancellation operation scope changed' USING ERRCODE='PT409';
   END IF;
   RETURN public.event_funnel_reversal_authorize(p_tenant,p_order,p_id,p_items,p_options);
 END IF;
 IF EXISTS(SELECT 1 FROM public.event_funnel_reversal WHERE id=p_id) OR EXISTS(
   SELECT 1 FROM public.event_funnel_reversal r CROSS JOIN LATERAL jsonb_array_elements(r.allocations) a
   WHERE r.tenant_id=p_tenant AND r.order_id=p_order AND r.state<>'released'
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(targets) t WHERE t->>'source'=a->>'source' AND t->>'id'=a->>'id')
 ) THEN RAISE EXCEPTION 'An existing cancellation requires reconciliation' USING ERRCODE='PT409';END IF;
 result:=public.event_funnel_reversal_authorize(p_tenant,p_order,p_id,p_items,p_options);
 UPDATE public.event_funnel_reversal SET requires_cleanup=true WHERE id=p_id;
 PERFORM public.event_funnel_reversal_cancel(p_tenant,p_order,p_id);
 INSERT INTO public.event_funnel_cancellation_approval(tenant_id,request_id,order_id,reversal_id,authority,approval_xid)
   SELECT p_tenant,id,p_order,p_id,authority,txid_current() FROM unnest(p_requests) id;
 UPDATE public.booking_cancellation_request SET status='approved',reviewed_by=p_authority->>'reviewer',
   reviewed_at=clock_timestamp(),review_notes=p_authority->>'reviewNotes' WHERE tenant_id=p_tenant AND id=ANY(p_requests);
 INSERT INTO public.event_funnel_cancellation_cleanup(tenant_id,order_id,reversal_id,snapshot)
   VALUES(p_tenant,p_order,p_id,jsonb_build_object('authority',authority,'requests',to_jsonb(p_requests),'registrations',targets));
 SELECT to_jsonb(r) INTO result FROM public.event_funnel_reversal r WHERE id=p_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_approve_cancellation(uuid,uuid,uuid,uuid[],jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_approve_cancellation(uuid,uuid,uuid,uuid[],jsonb,jsonb,jsonb) TO service_role;

DO $$
DECLARE definition text; anchor text;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_reversal_finish(uuid,uuid,uuid,uuid,jsonb)'::regprocedure) INTO definition;
 anchor:=$a$e.key NOT IN ('card','training','voucher','credit')$a$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Recovery outcome boundary changed';END IF;
 definition:=replace(definition,anchor,$a$e.key NOT IN ('card','training','voucher','credit','cleanup')$a$);
 anchor:=$a$IF final_state='complete' THEN$a$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Recovery completion boundary changed';END IF;
 definition:=replace(definition,anchor,$patch$
 IF r.requires_cleanup AND p_outcomes->>'cleanup' IS NULL THEN
   RAISE EXCEPTION 'Cancellation cleanup outcome is missing' USING ERRCODE='PT409';
 END IF;
 IF final_state='complete' AND r.requires_cleanup AND (
   p_outcomes->>'cleanup' IS DISTINCT FROM 'complete' OR NOT EXISTS(
     SELECT 1 FROM public.event_funnel_cancellation_cleanup WHERE tenant_id=p_tenant AND order_id=p_order
       AND reversal_id=p_id AND state='complete' AND receipt IS NOT NULL)
 ) THEN RAISE EXCEPTION 'Cancellation cleanup receipt is missing' USING ERRCODE='PT409';END IF;
 IF final_state='complete' THEN$patch$);
 EXECUTE definition;
END $$;
COMMIT;
