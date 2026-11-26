-- Additive activation authority. Installation never enables purchasing or jobs.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.event_funnel_rollout (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 workers_enabled boolean NOT NULL DEFAULT false,
 purchasing_enabled boolean NOT NULL DEFAULT false,
 reader_version integer NOT NULL DEFAULT 0 CHECK(reader_version>=0),
 worker_version integer NOT NULL DEFAULT 0 CHECK(worker_version>=0),
 verified_release text CHECK(verified_release ~ '^[a-f0-9]{40,64}$'),
 verification_evidence jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(verification_evidence)='object'),
 CHECK (NOT purchasing_enabled OR workers_enabled),
 CHECK (NOT workers_enabled OR coalesce((reader_version=1 AND worker_version=1 AND verified_release IS NOT NULL
   AND jsonb_typeof(verification_evidence->'authenticatedCheckout')='string'
   AND length(btrim(verification_evidence->>'authenticatedCheckout'))>0),false))
);
INSERT INTO public.event_funnel_rollout(singleton) VALUES(true);
CREATE TABLE public.event_funnel_worker_health (
 worker text PRIMARY KEY CHECK(worker IN ('recovery','reversals')),
 runtime_version integer NOT NULL,
 release text NOT NULL,
 seen_at timestamptz NOT NULL
);
ALTER TABLE public.event_funnel_rollout ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_worker_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_rollout,public.event_funnel_worker_health FROM PUBLIC,anon,authenticated;
GRANT SELECT,UPDATE ON public.event_funnel_rollout TO service_role;
GRANT SELECT ON public.event_funnel_worker_health TO service_role;

CREATE OR REPLACE FUNCTION public.event_funnel_readiness()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_rollout; installed boolean; workers boolean; healthy boolean; live boolean;
BEGIN
 SELECT * INTO r FROM public.event_funnel_rollout WHERE singleton;
 installed := to_regprocedure('public.event_funnel_membership_ready()') IS NOT NULL
   AND to_regprocedure('public.event_funnel_publish(uuid,uuid,integer,text,jsonb)') IS NOT NULL
   AND to_regprocedure('public.event_funnel_maintenance()') IS NOT NULL
   AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='event_funnel_recovery_claim')
   AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='event_funnel_reversal_claim');
 workers := coalesce(installed AND r.workers_enabled AND r.reader_version=1 AND r.worker_version=1
   AND r.verified_release IS NOT NULL,false);
 SELECT count(*)=2 INTO healthy FROM public.event_funnel_worker_health
   WHERE runtime_version=1 AND release=r.verified_release AND seen_at>statement_timestamp()-interval '5 minutes';
 live := coalesce(r.purchasing_enabled AND workers AND healthy,false);
 RETURN jsonb_build_object('version',1,'activationVersion',1,'authoring',true,'purchasing',live,
   'workersEnabled',workers,'workerVersion',coalesce(r.worker_version,0),
   'schemaReady',installed,'workersHealthy',healthy,
   'purchasePolicyInstalled',to_regprocedure('public.event_funnel_standalone_offer_allowed(uuid,text,uuid,jsonb)') IS NOT NULL,
   'legacyIntentAuthorityInstalled',to_regprocedure('public.event_funnel_prepare_legacy_intent(uuid,uuid,text,uuid,jsonb,jsonb)') IS NOT NULL,
   'reason',CASE WHEN live THEN NULL WHEN NOT installed THEN 'The membership and checkout schema updates are not fully installed.'
     WHEN NOT workers THEN 'Live checkout awaits verification of the deployed application and recovery workers.'
     WHEN NOT healthy THEN 'Live checkout is paused until both recovery workers report healthy.'
     ELSE 'Live checkout has not been activated.' END);
END $$;

CREATE FUNCTION public.event_funnel_worker_admission(p_worker text,p_version integer,p_release text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_rollout; ready jsonb;
BEGIN
 IF p_worker NOT IN ('recovery','reversals') OR p_worker IS NULL OR p_version IS DISTINCT FROM 1 THEN
   RAISE EXCEPTION 'Unsupported funnel worker' USING ERRCODE='22023';
 END IF;
 SELECT * INTO r FROM public.event_funnel_rollout WHERE singleton FOR SHARE;
 -- Only the explicitly reviewed application release can receive work or report
 -- health. Preview deployments use the JS production-environment fence too.
 IF r.verified_release IS NULL OR p_release IS DISTINCT FROM r.verified_release THEN
   RETURN jsonb_build_object('version',1,'enabled',false);
 END IF;
 INSERT INTO public.event_funnel_worker_health(worker,runtime_version,release,seen_at)
   VALUES(p_worker,p_version,p_release,clock_timestamp())
   ON CONFLICT(worker) DO UPDATE SET runtime_version=excluded.runtime_version,
     release=excluded.release,seen_at=excluded.seen_at;
 ready:=public.event_funnel_readiness();
 -- Recovery must remain available when NEW purchasing is paused.
 RETURN jsonb_build_object('version',1,'enabled',ready->'workersEnabled');
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_readiness(),public.event_funnel_worker_admission(text,integer,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_readiness(),public.event_funnel_worker_admission(text,integer,text)
 TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
