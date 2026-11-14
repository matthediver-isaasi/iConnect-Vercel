BEGIN;
CREATE FUNCTION public.awards_application_decide(
  p_tenant uuid,p_application uuid,p_expected_version bigint,p_actor_kind text,p_actor uuid,
  p_state text,p_reason text,p_self_service boolean DEFAULT false,p_access_hash text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.awards_application;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user','applicant_access') OR p_actor IS NULL OR p_self_service IS NULL
    OR (p_actor_kind='applicant_access' AND NOT p_self_service)
    OR p_state NOT IN ('eligible','ineligible','withdrawn','disqualified','pending')
    OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'State, actor and reason required'; END IF;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application unavailable' USING ERRCODE='P0002'; END IF;
  -- Same lock order as scoring: every affected round before the application.
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND award_id=a.award_id ORDER BY id FOR UPDATE;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application FOR UPDATE;
  IF p_self_service AND (p_state<>'withdrawn' OR NOT (
    (p_actor_kind='member' AND a.member_id IS NOT DISTINCT FROM p_actor)
    OR (p_actor_kind='applicant_access' AND p_actor IS NOT DISTINCT FROM public.awards_external_applicant(p_tenant,a.id,p_access_hash))
  )) THEN
    RAISE EXCEPTION 'Applicant action unavailable' USING ERRCODE='42501'; END IF;
  IF a.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Application changed' USING ERRCODE='40001'; END IF;
  IF p_self_service AND a.eligibility='withdrawn' THEN
    RETURN jsonb_build_object('id',a.id,'version',a.version,'status','withdrawn');
  END IF;
  IF coalesce((SELECT o.state<>'reopened' FROM public.awards_outcome_revision o WHERE o.tenant_id=p_tenant AND o.application_id=a.id ORDER BY revision DESC LIMIT 1),false) THEN
    RAISE EXCEPTION 'Review existing outcome decisions before changing application eligibility'; END IF;
  UPDATE public.awards_application SET eligibility=p_state,eligibility_reason=p_reason,version=version+1
    WHERE id=a.id RETURNING * INTO a;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,a.award_id,p_actor_kind,p_actor,'application.eligibility',a.id,p_reason,
      jsonb_build_object('eligibility',p_state,'version',a.version));
  RETURN jsonb_build_object('id',a.id,'version',a.version,'eligibility',a.eligibility);
END $$;
REVOKE ALL ON FUNCTION public.awards_application_decide(uuid,uuid,bigint,text,uuid,text,text,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_application_decide(uuid,uuid,bigint,text,uuid,text,text,boolean,text) TO service_role;
COMMIT;
