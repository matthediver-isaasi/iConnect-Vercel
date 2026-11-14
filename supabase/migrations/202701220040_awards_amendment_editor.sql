BEGIN;
CREATE FUNCTION public.awards_amendment_editor(p_tenant uuid,p_member uuid,p_application uuid,p_access_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.awards_application; w public.awards_competition; b public.awards_form_binding; f jsonb; answers jsonb; labels jsonb; published jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_member IS NULL AND public.awards_external_applicant(p_tenant,p_application,p_access_hash) IS NULL THEN
    RAISE EXCEPTION 'Applicant access expired or revoked' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application AND member_id IS NOT DISTINCT FROM p_member;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO w FROM public.awards_competition WHERE tenant_id=p_tenant AND id=a.award_id;
  IF NOT w.amendments_enabled OR w.state<>'open' OR w.opens_at IS NULL OR w.closes_at IS NULL
    OR clock_timestamp()<w.opens_at OR clock_timestamp()>=w.closes_at OR a.eligibility IN ('withdrawn','disqualified') THEN
    RAISE EXCEPTION 'Amendments are not available'; END IF;
  SELECT * INTO b FROM public.awards_form_binding WHERE tenant_id=p_tenant AND id=a.binding_id;
  SELECT to_jsonb(form) INTO f FROM public.form WHERE tenant_id=p_tenant AND id=b.form_id AND is_active;
  IF f IS NULL OR NOT b.active THEN RAISE EXCEPTION 'Application form unavailable'; END IF;
  IF f->>'form_type'='survey' THEN
    IF f->'survey_settings'->>'status' IS DISTINCT FROM 'published' THEN RAISE EXCEPTION 'Survey is not accepting amendments'; END IF;
    SELECT to_jsonb(v) INTO published FROM public.survey_version v WHERE tenant_id=p_tenant AND form_id=b.form_id
      AND version_number=coalesce((f->'survey_settings'->>'current_version')::integer,1);
    IF published IS NULL THEN RAISE EXCEPTION 'Published survey version unavailable'; END IF;
    f:=f||jsonb_build_object('fields',published->'fields','pages',published->'pages','visibility_rules',published->'visibility_rules',
      'survey_settings',coalesce(f->'survey_settings','{}')||coalesce(published->'survey_settings','{}'));
    IF coalesce(f->'survey_settings'->>'response_identity','identified')<>'identified' THEN
      RAISE EXCEPTION 'Survey no longer permits identified amendments';
    END IF;
  END IF;
  SELECT answer_snapshot,display_snapshot INTO answers,labels FROM public.awards_application_version WHERE tenant_id=p_tenant AND application_id=a.id ORDER BY revision DESC LIMIT 1;
  RETURN jsonb_build_object('applicationId',a.id,'awardId',w.id,'tenantId',p_tenant,'reference',a.reference,'version',a.version,
    'formId',b.form_id,'formSlug',f->>'slug','answers',answers,'displaySnapshot',labels,'deadline',w.closes_at,
    'form',jsonb_build_object('id',b.form_id,'tenant_id',p_tenant,'slug',f->>'slug','name',f->>'name',
      'title',f->>'title','description',f->>'description','fields',f->'fields','pages',f->'pages',
      'visibility_rules',f->'visibility_rules','form_type',f->>'form_type','survey_settings',f->'survey_settings'));
END $$;
REVOKE ALL ON FUNCTION public.awards_amendment_editor(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_amendment_editor(uuid,uuid,uuid,text) TO service_role;
COMMIT;
