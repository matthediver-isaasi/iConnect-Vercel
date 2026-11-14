BEGIN;
CREATE FUNCTION public.awards_flag_potential_duplicates(p_tenant uuid,p_application uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE application public.awards_application; email_key text; matches uuid[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO application FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application unavailable'; END IF;
  SELECT nullif(lower(btrim(to_jsonb(s)->>'submitted_by_email')),'') INTO email_key
    FROM public.form_submission s WHERE tenant_id=p_tenant AND id=application.submission_id;
  SELECT array_agg(a.id) INTO matches FROM public.awards_application a
    JOIN public.form_submission s ON s.tenant_id=a.tenant_id AND s.id=a.submission_id
    WHERE a.tenant_id=p_tenant AND a.award_id=application.award_id AND a.id<>application.id
      AND ((application.member_id IS NOT NULL AND a.member_id=application.member_id)
        OR (email_key IS NOT NULL AND nullif(lower(btrim(to_jsonb(s)->>'submitted_by_email')),'')=email_key));
  IF cardinality(matches)>0 THEN
    UPDATE public.awards_application SET duplicate_flag=true,version=version+CASE WHEN id=application.id THEN 0 ELSE 1 END
      WHERE tenant_id=p_tenant AND (id=application.id OR id=ANY(matches)) AND NOT duplicate_flag;
    INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,action,subject_id,reason,changes)
      VALUES(p_tenant,application.award_id,'system','application.duplicate_flag',application.id,
        'Potential duplicate only; no automatic eligibility change, merge or deletion',
        jsonb_build_object('related_application_ids',to_jsonb(matches)));
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.awards_flag_potential_duplicates(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
