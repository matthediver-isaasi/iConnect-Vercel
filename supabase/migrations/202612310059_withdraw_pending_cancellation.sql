BEGIN;
LOCK TABLE public.member_cancellation_request IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.member_cancellation_request
 DROP CONSTRAINT member_cancellation_request_source_record_id_key;
CREATE UNIQUE INDEX member_cancellation_active_source
 ON public.member_cancellation_request(source_record_id) WHERE withdrawn_at IS NULL;

-- Pinned, narrowly scoped evolution of admission: a withdrawn request is
-- historical evidence, not a permanent reservation of the purchase.
DO $$
DECLARE fn regprocedure:='public.begin_member_cancellation(uuid,uuid,uuid,text,text,jsonb)'::regprocedure;
 body text; definition text;
BEGIN
 SELECT prosrc INTO body FROM pg_proc WHERE oid=fn;
 IF md5(btrim(body,E' \n\r\t'))<>'004e3f34c08963c7e7d83f7c5c9cff91' THEN
  RAISE EXCEPTION 'Cancellation admission differs from the reviewed source contract';
 END IF;
 definition:=pg_get_functiondef(fn);
 EXECUTE replace(definition,'WHERE source_record_id=h.id)',
  'WHERE source_record_id=h.id AND withdrawn_at IS NULL)');
END $$;

CREATE FUNCTION public.withdraw_member_cancellation(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request;
BEGIN
 IF p_actor_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
  RAISE EXCEPTION 'An authenticated actor and withdrawal reason are required';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owned member required'; END IF;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owned cancellation required'; END IF;
 IF r.access_ended_at IS NOT NULL THEN
  RAISE EXCEPTION 'Membership access has already ended; withdrawal cannot restore it';
 END IF;
 IF r.withdrawn_at IS NOT NULL THEN RETURN to_jsonb(r); END IF;
 IF EXISTS(SELECT 1 FROM public.member_cancellation_provider_stop
  WHERE id=r.id AND state<>'pending') THEN
  RAISE EXCEPTION 'Provider execution has started; reconcile it before any change';
 END IF;
 UPDATE public.member_cancellation_request SET withdrawn_at=clock_timestamp()
  WHERE id=r.id RETURNING * INTO r;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(r.id,p_actor_id,'withdrawn',jsonb_build_object('reason',btrim(p_reason),
  'accessChanged',false,'financialSettlementChanged',false));
 RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.withdraw_member_cancellation(uuid,uuid,uuid,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_member_cancellation(uuid,uuid,uuid,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
