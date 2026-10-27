BEGIN;
CREATE TABLE public.member_replacement_job(
 execution_id uuid NOT NULL REFERENCES public.member_replacement_execution(id),
 kind text NOT NULL CHECK(kind IN ('reconcile','payment','confirmation')),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),member_id uuid NOT NULL REFERENCES public.member(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','completed','blocked','uncertain')),
 available_at timestamptz NOT NULL DEFAULT now(),claim_token uuid,lease_until timestamptz,
 evidence jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(execution_id,kind)
);
ALTER TABLE public.member_replacement_job ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_replacement_job FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_replacement_job TO service_role;
CREATE INDEX member_replacement_job_due ON public.member_replacement_job(kind,available_at,execution_id) WHERE state IN ('pending','claimed');

CREATE FUNCTION public.pending_member_replacement_jobs(p_kind text,p_limit integer DEFAULT 10)
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF p_kind NOT IN ('all','reconcile','payment','confirmation') OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid job query'; END IF;
 -- Recovery is read-only at providers. Expired email claims are NOT retry grants.
 UPDATE public.member_replacement_job SET state=CASE WHEN kind='reconcile' THEN 'pending' ELSE 'uncertain' END,
  claim_token=NULL,lease_until=NULL,updated_at=now(),evidence=jsonb_build_object('reason','lease_expired')
  WHERE (p_kind='all' OR kind=p_kind) AND state='claimed' AND lease_until<=now();
 RETURN QUERY SELECT to_jsonb(j) FROM public.member_replacement_job j
  WHERE (p_kind='all' OR j.kind=p_kind) AND j.state='pending' AND j.available_at<=now()
  ORDER BY j.available_at,j.execution_id,j.kind LIMIT p_limit;
END $$;
CREATE FUNCTION public.claim_member_replacement_job(p_tenant_id uuid,p_execution_id uuid,p_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.member_replacement_job;
BEGIN
 UPDATE public.member_replacement_job SET state='claimed',claim_token=gen_random_uuid(),
  lease_until=now()+interval '2 minutes',updated_at=now()
  WHERE tenant_id=p_tenant_id AND execution_id=p_execution_id AND kind=p_kind
   AND state='pending' AND available_at<=now() RETURNING * INTO j;
 RETURN CASE WHEN FOUND THEN to_jsonb(j) ELSE NULL END;
END $$;
CREATE FUNCTION public.finish_member_replacement_job(p_tenant_id uuid,p_execution_id uuid,p_kind text,
 p_claim_token uuid,p_state text,p_evidence jsonb,p_delay integer DEFAULT 300)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.member_replacement_job;
BEGIN
 IF p_state NOT IN ('pending','completed','blocked','uncertain') OR jsonb_typeof(p_evidence)<>'object'
  OR p_delay NOT BETWEEN 1 AND 86400 THEN RAISE EXCEPTION 'Invalid job outcome'; END IF;
 IF p_kind<>'reconcile' AND p_state='pending' AND p_evidence->>'notSubmitted' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'Email retry requires definitive non-submission'; END IF;
 UPDATE public.member_replacement_job SET state=p_state,evidence=p_evidence,
  claim_token=NULL,lease_until=NULL,available_at=now()+make_interval(secs=>p_delay),updated_at=now()
  WHERE tenant_id=p_tenant_id AND execution_id=p_execution_id AND kind=p_kind
   AND state='claimed' AND claim_token=p_claim_token RETURNING * INTO j;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job claim is no longer owned'; END IF;
 RETURN to_jsonb(j);
END $$;
CREATE FUNCTION public.queue_member_replacement_payment(p_tenant_id uuid,p_execution_id uuid,p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.member_replacement_execution;
BEGIN
 SELECT * INTO e FROM public.member_replacement_execution WHERE id=p_execution_id AND tenant_id=p_tenant_id;
 IF NOT FOUND OR e.plan->>'choice'<>'collect'
  OR p_evidence->>'verified' IS DISTINCT FROM 'true'
  OR p_evidence->>'kind' IS DISTINCT FROM 'awaiting_replacement_payment'
  OR NOT EXISTS(SELECT 1 FROM public.member_replacement_step s WHERE s.execution_id=e.id
   AND s.step_key='new_invoice' AND s.state='observed' AND s.evidence->>'id'=p_evidence->>'invoiceId')
 THEN RAISE EXCEPTION 'Verified replacement invoice required'; END IF;
 INSERT INTO public.member_replacement_job(execution_id,kind,tenant_id,member_id)
 VALUES(e.id,'payment',e.tenant_id,e.member_id) ON CONFLICT DO NOTHING;
END $$;

ALTER FUNCTION public.begin_member_replacement(uuid,uuid,uuid,uuid,text,jsonb) RENAME TO begin_member_replacement_before_jobs;
REVOKE ALL ON FUNCTION public.begin_member_replacement_before_jobs(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.begin_member_replacement(p_tenant_id uuid,p_member_id uuid,p_authority_id uuid,p_actor_id uuid,p_reason text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 result:=public.begin_member_replacement_before_jobs(p_tenant_id,p_member_id,p_authority_id,p_actor_id,p_reason,p_plan);
 INSERT INTO public.member_replacement_job(execution_id,kind,tenant_id,member_id)
 VALUES((result->>'id')::uuid,'reconcile',p_tenant_id,p_member_id) ON CONFLICT DO NOTHING;
 RETURN result;
END $$;
ALTER FUNCTION public.apply_member_replacement(uuid,uuid,uuid,jsonb,jsonb) RENAME TO apply_member_replacement_before_jobs;
REVOKE ALL ON FUNCTION public.apply_member_replacement_before_jobs(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.apply_member_replacement(p_tenant_id uuid,p_execution_id uuid,p_actor_id uuid,p_evidence jsonb,p_history jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 result:=public.apply_member_replacement_before_jobs(p_tenant_id,p_execution_id,p_actor_id,p_evidence,p_history);
 INSERT INTO public.member_replacement_job(execution_id,kind,tenant_id,member_id)
 SELECT id,'confirmation',tenant_id,member_id FROM public.member_replacement_execution
 WHERE id=p_execution_id AND tenant_id=p_tenant_id ON CONFLICT DO NOTHING;
 RETURN result;
END $$;
CREATE FUNCTION public.member_replacement_execution_available(p_protocol text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT p_protocol='upfront-replacement-v1'
$$;
REVOKE ALL ON FUNCTION public.begin_member_replacement(uuid,uuid,uuid,uuid,text,jsonb),
 public.apply_member_replacement(uuid,uuid,uuid,jsonb,jsonb),
 public.pending_member_replacement_jobs(text,integer),public.claim_member_replacement_job(uuid,uuid,text),
 public.finish_member_replacement_job(uuid,uuid,text,uuid,text,jsonb,integer),
 public.queue_member_replacement_payment(uuid,uuid,jsonb),public.member_replacement_execution_available(text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_member_replacement(uuid,uuid,uuid,uuid,text,jsonb),
 public.apply_member_replacement(uuid,uuid,uuid,jsonb,jsonb),
 public.pending_member_replacement_jobs(text,integer),public.claim_member_replacement_job(uuid,uuid,text),
 public.finish_member_replacement_job(uuid,uuid,text,uuid,text,jsonb,integer),
 public.queue_member_replacement_payment(uuid,uuid,jsonb),public.member_replacement_execution_available(text)
 TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
