BEGIN;
ALTER TABLE public.awards_outcome_revision ADD COLUMN ranking_sources jsonb NOT NULL DEFAULT '{}'
  CHECK(jsonb_typeof(ranking_sources)='object');
CREATE FUNCTION public.assessment_ranking_sources(p_tenant uuid,p_round uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce(jsonb_object_agg(a.id::text,public.assessment_source_fingerprint(
    public.assessment_evidence(p_tenant,p_round,a.id))),'{}')
  FROM public.awards_application a JOIN public.assessment_round r ON r.award_id=a.award_id AND r.tenant_id=a.tenant_id
  WHERE r.tenant_id=p_tenant AND r.id=p_round AND public.assessment_round_candidate(p_tenant,r.id,a.id);
$$;
REVOKE ALL ON FUNCTION public.assessment_ranking_sources(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
