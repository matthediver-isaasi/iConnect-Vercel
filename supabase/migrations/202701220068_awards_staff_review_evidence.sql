BEGIN;
CREATE FUNCTION public.awards_staff_review(p_tenant uuid,p_round uuid,p_application uuid,p_actor_kind text,p_actor uuid,p_version uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source_id uuid; source_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.assessment_round r JOIN public.awards_application a ON a.tenant_id=r.tenant_id AND a.award_id=r.award_id
    WHERE r.tenant_id=p_tenant AND r.id=p_round AND a.id=p_application)
    OR public.assessment_actor_conflicted(p_tenant,p_round,p_application,public.assessment_actor_keys(p_tenant,p_actor_kind,p_actor)) THEN
    RAISE EXCEPTION 'Round evidence unavailable' USING ERRCODE='42501';
  END IF;
  IF p_version IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.assessment_revision v JOIN public.assessment_assignment a ON a.id=v.assignment_id AND a.tenant_id=v.tenant_id
      WHERE v.tenant_id=p_tenant AND a.round_id=p_round AND a.application_id=p_application AND v.application_version_id=p_version AND v.state='submitted') THEN
      RAISE EXCEPTION 'Historical review evidence unavailable' USING ERRCODE='42501';
    END IF;
    source_id:=p_version;
  ELSE
    SELECT count(DISTINCT application_version_id),min(application_version_id::text)::uuid INTO source_count,source_id
      FROM public.assessment_assignment WHERE tenant_id=p_tenant AND round_id=p_round AND application_id=p_application
        AND included AND state='assigned' AND conflict IN ('none','cleared');
    IF source_count<>1 THEN RAISE EXCEPTION 'Included assignments must share one review version'; END IF;
  END IF;
  RETURN (SELECT to_jsonb(v) FROM public.awards_application_version v WHERE tenant_id=p_tenant AND application_id=p_application AND id=source_id);
END $$;
CREATE FUNCTION public.awards_staff_attachment(p_tenant uuid,p_round uuid,p_application uuid,p_actor_kind text,p_actor uuid,p_version uuid,p_attachment uuid,p_offset integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE snapshot jsonb;
BEGIN
  snapshot:=public.awards_staff_review(p_tenant,p_round,p_application,p_actor_kind,p_actor,p_version);
  RETURN public.awards_attachment_chunk(p_tenant,(snapshot->>'id')::uuid,p_attachment,p_offset);
END $$;
REVOKE ALL ON FUNCTION public.awards_staff_review(uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_staff_attachment(uuid,uuid,uuid,text,uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_staff_review(uuid,uuid,uuid,text,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_staff_attachment(uuid,uuid,uuid,text,uuid,uuid,uuid,integer) TO service_role;
COMMIT;
