BEGIN;
CREATE FUNCTION public.awards_applicant_review(p_tenant uuid,p_member uuid,p_application uuid,p_access_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE application public.awards_application; snapshot public.awards_application_version;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO application FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application;
  IF NOT FOUND OR NOT ((p_member IS NOT NULL AND application.member_id IS NOT DISTINCT FROM p_member AND p_access_hash IS NULL)
    OR (p_member IS NULL AND public.awards_external_applicant(p_tenant,p_application,p_access_hash) IS NOT NULL)) THEN
    RAISE EXCEPTION 'Application evidence unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO snapshot FROM public.awards_application_version WHERE tenant_id=p_tenant AND application_id=application.id ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application evidence unavailable'; END IF;
  RETURN to_jsonb(snapshot);
END $$;
CREATE FUNCTION public.awards_applicant_attachment(p_tenant uuid,p_member uuid,p_application uuid,p_attachment uuid,p_offset integer,p_access_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE snapshot jsonb;
BEGIN
  snapshot:=public.awards_applicant_review(p_tenant,p_member,p_application,p_access_hash);
  RETURN public.awards_attachment_chunk(p_tenant,(snapshot->>'id')::uuid,p_attachment,p_offset);
END $$;
CREATE FUNCTION public.assessment_panel_review(p_tenant uuid,p_round uuid,p_application uuid,p_member uuid,p_session_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE snapshot uuid; distinct_versions integer;
BEGIN
  PERFORM public.assessment_panel_evidence(p_tenant,p_round,p_application,p_member,p_session_hash,1);
  SELECT count(DISTINCT application_version_id),min(application_version_id::text)::uuid INTO distinct_versions,snapshot
    FROM public.assessment_assignment WHERE tenant_id=p_tenant AND round_id=p_round AND application_id=p_application
      AND state='assigned' AND included AND conflict IN ('none','cleared');
  IF distinct_versions<>1 THEN RAISE EXCEPTION 'Included assignments must share one review version'; END IF;
  RETURN (SELECT to_jsonb(v) FROM public.awards_application_version v WHERE tenant_id=p_tenant AND application_id=p_application AND id=snapshot);
END $$;
CREATE FUNCTION public.assessment_panel_attachment(p_tenant uuid,p_round uuid,p_application uuid,p_member uuid,p_session_hash text,p_attachment uuid,p_offset integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE snapshot jsonb;
BEGIN
  snapshot:=public.assessment_panel_review(p_tenant,p_round,p_application,p_member,p_session_hash);
  RETURN public.awards_attachment_chunk(p_tenant,(snapshot->>'id')::uuid,p_attachment,p_offset);
END $$;
REVOKE ALL ON FUNCTION public.awards_applicant_review(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_applicant_attachment(uuid,uuid,uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_panel_review(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_panel_attachment(uuid,uuid,uuid,uuid,text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_applicant_review(uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_applicant_attachment(uuid,uuid,uuid,uuid,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_panel_review(uuid,uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_panel_attachment(uuid,uuid,uuid,uuid,text,uuid,integer) TO service_role;
COMMIT;
