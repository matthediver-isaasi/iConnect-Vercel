-- Private journal only. Access application and public execution remain gated
-- until the complete cancellation protocol is installed.
BEGIN;
CREATE TABLE public.member_cancellation_request (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 source_record_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id),
 actor_id uuid NOT NULL,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 effective_date date NOT NULL,
 timing text NOT NULL CHECK(timing IN ('immediate','end_of_term')),
 source_snapshot jsonb NOT NULL,
 calculation jsonb NOT NULL,
 access_ended_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,member_id,request_key)
);
CREATE TABLE public.member_cancellation_provider_stop (
 id uuid PRIMARY KEY REFERENCES public.member_cancellation_request(id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 prepared jsonb NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','uncertain','stopped')),
 claim_token uuid,
 evidence jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.member_cancellation_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL REFERENCES public.member_cancellation_request(id),
 actor_id uuid NOT NULL,
 kind text NOT NULL,
 evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_cancellation_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_cancellation_provider_stop ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_cancellation_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_cancellation_request,public.member_cancellation_provider_stop,
 public.member_cancellation_event FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_cancellation_request,public.member_cancellation_provider_stop,
 public.member_cancellation_event TO service_role;
CREATE INDEX member_cancellation_owner ON public.member_cancellation_request(tenant_id,member_id,effective_date);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_cancellation_event
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();

CREATE FUNCTION public.claim_member_cancellation_provider_stop(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; s public.member_cancellation_provider_stop;
BEGIN
 IF p_actor_id IS NULL THEN RAISE EXCEPTION 'Audit actor required'; END IF;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR r.access_ended_at IS NULL THEN
  RAISE EXCEPTION 'Applied, owned cancellation required before provider stop';
 END IF;
 SELECT * INTO s FROM public.member_cancellation_provider_stop
  WHERE id=r.id AND tenant_id=r.tenant_id AND member_id=r.member_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Provider stop journal missing'; END IF;
 IF s.state<>'pending' THEN
  RETURN jsonb_build_object('claimed',false,'operation',to_jsonb(s));
 END IF;
 UPDATE public.member_cancellation_provider_stop SET state='claimed',
  claim_token=gen_random_uuid(),updated_at=clock_timestamp()
  WHERE id=s.id RETURNING * INTO s;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(r.id,p_actor_id,'provider_stop_claimed',jsonb_build_object('claimToken',s.claim_token));
 RETURN jsonb_build_object('claimed',true,'operation',to_jsonb(s));
END $$;

CREATE FUNCTION public.record_member_cancellation_provider_stop(
 p_tenant_id uuid,p_member_id uuid,p_id uuid,p_actor_id uuid,
 p_claim_token uuid,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_cancellation_request; s public.member_cancellation_provider_stop; a jsonb;
BEGIN
 IF p_actor_id IS NULL OR p_claim_token IS NULL
  OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
  OR NOT COALESCE(p_evidence->>'state' IN ('stopped','uncertain','active'),false)
 THEN RAISE EXCEPTION 'A scoped provider observation is required'; END IF;
 SELECT * INTO r FROM public.member_cancellation_request
  WHERE id=p_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR r.access_ended_at IS NULL THEN RAISE EXCEPTION 'Cancellation not applied'; END IF;
 SELECT * INTO s FROM public.member_cancellation_provider_stop
  WHERE id=r.id AND tenant_id=r.tenant_id AND member_id=r.member_id FOR UPDATE;
 IF NOT FOUND OR s.claim_token IS DISTINCT FROM p_claim_token
  OR s.state NOT IN ('claimed','uncertain','stopped') THEN RAISE EXCEPTION 'Stale cancellation claim'; END IF;
 a:=s.prepared->'authority';
 IF p_evidence->>'subscriptionId' IS DISTINCT FROM a->>'subscriptionId'
  OR (a->>'provider'='stripe' AND p_evidence->>'state'='stopped'
   AND p_evidence->>'scheduleId' IS DISTINCT FROM a->>'scheduleId')
 THEN RAISE EXCEPTION 'Provider observation belongs to another subscription'; END IF;
 IF s.state='stopped' THEN RETURN to_jsonb(s); END IF;
 -- Neither an expired worker nor an active provider read grants a new write.
 UPDATE public.member_cancellation_provider_stop SET
  state=CASE WHEN p_evidence->>'state'='stopped' THEN 'stopped' ELSE 'uncertain' END,
  evidence=p_evidence,updated_at=clock_timestamp()
  WHERE id=s.id RETURNING * INTO s;
 INSERT INTO public.member_cancellation_event(request_id,actor_id,kind,evidence)
 VALUES(r.id,p_actor_id,'provider_stop_observed',p_evidence);
 RETURN to_jsonb(s);
END $$;
REVOKE ALL ON FUNCTION public.claim_member_cancellation_provider_stop(uuid,uuid,uuid,uuid),
 public.record_member_cancellation_provider_stop(uuid,uuid,uuid,uuid,uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_member_cancellation_provider_stop(uuid,uuid,uuid,uuid),
 public.record_member_cancellation_provider_stop(uuid,uuid,uuid,uuid,uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
