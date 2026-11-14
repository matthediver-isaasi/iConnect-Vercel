BEGIN;
CREATE FUNCTION public.awards_prepare_amendment(p_tenant uuid,p_member uuid,p_application uuid,p_submission uuid,p_version bigint,p_answers jsonb,p_access_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.awards_application; w public.awards_competition; b public.awards_form_binding; captured public.awards_intake_capture;
  f jsonb; survey uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF (p_member IS NULL AND public.awards_external_applicant(p_tenant,p_application,p_access_hash) IS NULL) OR p_submission IS NULL OR jsonb_typeof(p_answers) IS DISTINCT FROM 'object' OR octet_length(p_answers::text)>500000 THEN
    RAISE EXCEPTION 'Invalid amendment request'; END IF;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application AND member_id IS NOT DISTINCT FROM p_member;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO w FROM public.awards_competition WHERE tenant_id=p_tenant AND id=a.award_id FOR UPDATE;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application AND member_id IS NOT DISTINCT FROM p_member FOR UPDATE;
  IF p_member IS NULL AND public.awards_external_applicant(p_tenant,p_application,p_access_hash) IS NULL THEN
    RAISE EXCEPTION 'Applicant access expired or revoked' USING ERRCODE='42501'; END IF;
  SELECT * INTO captured FROM public.awards_intake_capture WHERE submission_id=p_submission;
  IF FOUND THEN
    IF captured.tenant_id IS DISTINCT FROM p_tenant OR captured.member_id IS DISTINCT FROM p_member
      OR captured.binding_id IS DISTINCT FROM a.binding_id OR captured.answer_snapshot IS DISTINCT FROM p_answers
      OR NOT EXISTS(SELECT 1 FROM public.form_submission WHERE id=p_submission AND awards_amendment_application_id=a.id) THEN
      RAISE EXCEPTION 'Amendment request ID already used' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('form',captured.form_snapshot,'answers',captured.answer_snapshot,'replayed',true);
  END IF;
  IF a.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Application changed' USING ERRCODE='40001'; END IF;
  SELECT * INTO b FROM public.awards_form_binding WHERE tenant_id=p_tenant AND id=a.binding_id;
  SELECT to_jsonb(form) INTO f FROM public.form WHERE tenant_id=p_tenant AND id=b.form_id AND is_active FOR SHARE;
  IF f IS NULL OR NOT b.active THEN RAISE EXCEPTION 'Application form unavailable'; END IF;
  IF f->>'form_type'='survey' THEN
    IF f->'survey_settings'->>'status' IS DISTINCT FROM 'published' THEN RAISE EXCEPTION 'Survey is not accepting amendments'; END IF;
    SELECT id INTO survey FROM public.survey_version WHERE tenant_id=p_tenant AND form_id=b.form_id
      AND version_number=coalesce((f->'survey_settings'->>'current_version')::integer,1);
    IF survey IS NULL THEN RAISE EXCEPTION 'Published survey version unavailable'; END IF;
    INSERT INTO public.form_submission(id,tenant_id,form_id,submission_data,awards_binding_id,awards_applicant_member_id,awards_amendment_application_id,survey_version_id,payment_status,submission_email_state)
      VALUES(p_submission,p_tenant,b.form_id,p_answers,b.id,p_member,a.id,survey,NULL,'{"status":"suppressed","reason":"award_evidence_only"}');
  ELSE
    INSERT INTO public.form_submission(id,tenant_id,form_id,submission_data,awards_binding_id,awards_applicant_member_id,awards_amendment_application_id,payment_status,submission_email_state)
      VALUES(p_submission,p_tenant,b.form_id,p_answers,b.id,p_member,a.id,NULL,'{"status":"suppressed","reason":"award_evidence_only"}');
  END IF;
  SELECT * INTO captured FROM public.awards_intake_capture WHERE submission_id=p_submission;
  RETURN jsonb_build_object('form',captured.form_snapshot,'answers',captured.answer_snapshot,'replayed',false);
END $$;
CREATE FUNCTION public.awards_copy_amendment_files(p_tenant uuid,p_application uuid,p_submission uuid,p_field text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE captured public.awards_intake_capture; previous public.awards_application_version;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT c.* INTO captured FROM public.awards_intake_capture c JOIN public.form_submission s ON s.id=c.submission_id
    JOIN public.awards_application a ON a.id=s.awards_amendment_application_id AND a.member_id IS NOT DISTINCT FROM c.member_id AND a.tenant_id=c.tenant_id
    WHERE c.tenant_id=p_tenant AND a.id=p_application AND s.id=p_submission FOR UPDATE OF c;
  IF NOT FOUND THEN RAISE EXCEPTION 'Amendment unavailable'; END IF;
  SELECT * INTO previous FROM public.awards_application_version WHERE tenant_id=p_tenant AND application_id=p_application ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND OR NOT (captured.form_snapshot->'review_field_ids' ? p_field)
    OR captured.answer_snapshot->p_field IS DISTINCT FROM previous.answer_snapshot->p_field THEN RETURN false; END IF;
  INSERT INTO public.awards_review_attachment(tenant_id,submission_id,field_id,source_path,name,content,digest)
    SELECT p_tenant,p_submission,f.field_id,f.source_path,f.name,f.content,f.digest FROM public.awards_review_attachment f
      WHERE f.tenant_id=p_tenant AND f.field_id=p_field AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(previous.attachment_manifest) item WHERE item->>'id'=f.id::text AND item->>'field_id'=p_field)
    ON CONFLICT(submission_id,field_id,cell_id,source_path) DO NOTHING;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.awards_prepare_amendment(uuid,uuid,uuid,uuid,bigint,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_copy_amendment_files(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_prepare_amendment(uuid,uuid,uuid,uuid,bigint,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_copy_amendment_files(uuid,uuid,uuid,text) TO service_role;
COMMIT;
