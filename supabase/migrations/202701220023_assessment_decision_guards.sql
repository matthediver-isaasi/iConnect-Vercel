BEGIN;
CREATE FUNCTION public.assessment_has_active_decisions(p_tenant uuid,p_round uuid,p_application uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.assessment_moderation
      WHERE tenant_id=p_tenant AND round_id=p_round AND application_id=p_application AND state IN ('proposed','approved'))
    OR coalesce((SELECT state IN ('recommended','confirmed') FROM public.assessment_shortlist_decision
      WHERE tenant_id=p_tenant AND round_id=p_round AND application_id=p_application ORDER BY revision DESC LIMIT 1),false)
    OR coalesce((SELECT state<>'reopened' FROM public.awards_outcome_revision
      WHERE tenant_id=p_tenant AND application_id=p_application ORDER BY revision DESC LIMIT 1),false);
$$;
REVOKE ALL ON FUNCTION public.assessment_has_active_decisions(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
