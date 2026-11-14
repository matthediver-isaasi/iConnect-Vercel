BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS awards_delivery_applicant_tenant ON public.awards_delivery(tenant_id,id);
ALTER TABLE public.awards_applicant_access ADD CONSTRAINT awards_applicant_access_delivery_tenant
  FOREIGN KEY(tenant_id,delivery_id) REFERENCES public.awards_delivery(tenant_id,id);
CREATE FUNCTION public.awards_applicant_access_control(p_tenant uuid,p_application uuid,p_command text,p_page integer DEFAULT 1,
  p_version text DEFAULT NULL,p_actor_kind text DEFAULT NULL,p_actor uuid DEFAULT NULL,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.awards_application; version text; total integer; rows jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_command NOT IN ('read','revoke') OR p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid access request'; END IF;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=a.award_id FOR UPDATE;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application FOR UPDATE;
  SELECT count(*),md5(coalesce(string_agg(id::text,',' ORDER BY id),'')) INTO total,version
    FROM public.awards_applicant_access WHERE tenant_id=p_tenant AND application_id=a.id AND revoked_at IS NULL;
  IF p_command='read' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'expiresAt',expires_at) ORDER BY id),'[]') INTO rows
      FROM (SELECT id,expires_at FROM public.awards_applicant_access WHERE tenant_id=p_tenant AND application_id=a.id
        AND revoked_at IS NULL ORDER BY id LIMIT 50 OFFSET (p_page-1)*50) selected;
    RETURN jsonb_build_object('links',rows,'total',total,'version',version,'page',p_page,'pageSize',50,'memberOwned',a.member_id IS NOT NULL);
  END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0 OR length(p_reason)>2000 THEN
    RAISE EXCEPTION 'Revocation authority and reason required'; END IF;
  IF version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Applicant links changed; review current access' USING ERRCODE='40001'; END IF;
  UPDATE public.awards_applicant_access SET revoked_at=clock_timestamp() WHERE tenant_id=p_tenant AND application_id=a.id AND revoked_at IS NULL;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,a.award_id,p_actor_kind,p_actor,'application.access_revoked',a.id,p_reason,jsonb_build_object('revoked_count',total));
  RETURN jsonb_build_object('revoked',true,'revokedCount',total);
END $$;
REVOKE ALL ON FUNCTION public.awards_applicant_access_control(uuid,uuid,text,integer,text,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_applicant_access_control(uuid,uuid,text,integer,text,text,uuid,text) TO service_role;
COMMIT;
