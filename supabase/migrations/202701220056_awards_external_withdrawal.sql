BEGIN;
CREATE FUNCTION public.awards_external_withdraw(p_tenant uuid,p_application uuid,p_hash text,p_version bigint,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE access_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  access_id:=public.awards_external_applicant(p_tenant,p_application,p_hash);
  IF access_id IS NULL THEN RAISE EXCEPTION 'Applicant access expired, revoked or unavailable' USING ERRCODE='42501'; END IF;
  RETURN public.awards_application_decide(p_tenant,p_application,p_version,'applicant_access',access_id,'withdrawn',p_reason,true,p_hash);
END $$;
REVOKE ALL ON FUNCTION public.awards_external_withdraw(uuid,uuid,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_external_withdraw(uuid,uuid,text,bigint,text) TO service_role;
COMMIT;
