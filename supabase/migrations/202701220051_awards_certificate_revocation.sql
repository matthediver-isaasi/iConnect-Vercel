BEGIN;
CREATE FUNCTION public.awards_certificate_links(p_tenant uuid,p_issue uuid,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE total integer; version text; rows jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid page'; END IF;
  PERFORM 1 FROM public.awards_certificate_issue WHERE tenant_id=p_tenant AND id=p_issue FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Certificate unavailable' USING ERRCODE='P0002'; END IF;
  SELECT count(*),md5(coalesce(string_agg(id::text,',' ORDER BY id),'')) INTO total,version
    FROM public.awards_certificate_access WHERE tenant_id=p_tenant AND issue_id=p_issue AND revoked_at IS NULL;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'expiresAt',expires_at) ORDER BY id),'[]') INTO rows
    FROM (SELECT id,expires_at FROM public.awards_certificate_access
      WHERE tenant_id=p_tenant AND issue_id=p_issue AND revoked_at IS NULL ORDER BY id LIMIT 50 OFFSET (p_page-1)*50) selected;
  RETURN jsonb_build_object('links',rows,'total',total,'version',version,'page',p_page,'pageSize',50);
END $$;
CREATE FUNCTION public.awards_revoke_certificate_links(p_tenant uuid,p_issue uuid,p_version text,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE issued public.awards_certificate_issue; current_version text; affected integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0 OR length(p_reason)>2000 THEN
    RAISE EXCEPTION 'Revocation authority and reason required'; END IF;
  SELECT * INTO issued FROM public.awards_certificate_issue WHERE tenant_id=p_tenant AND id=p_issue FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Certificate unavailable' USING ERRCODE='P0002'; END IF;
  SELECT md5(coalesce(string_agg(id::text,',' ORDER BY id),'')) INTO current_version
    FROM public.awards_certificate_access WHERE tenant_id=p_tenant AND issue_id=p_issue AND revoked_at IS NULL;
  IF current_version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Certificate links changed; review the current links' USING ERRCODE='40001'; END IF;
  UPDATE public.awards_certificate_access SET revoked_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND issue_id=p_issue AND revoked_at IS NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,issued.award_id,p_actor_kind,p_actor,'certificate.links_revoked',issued.id,p_reason,
      jsonb_build_object('revoked_count',affected,'issued_pdf','retained'));
  RETURN jsonb_build_object('revoked',true,'revokedCount',affected);
END $$;
REVOKE ALL ON FUNCTION public.awards_certificate_links(uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_revoke_certificate_links(uuid,uuid,text,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_certificate_links(uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_revoke_certificate_links(uuid,uuid,text,text,uuid,text) TO service_role;
COMMIT;
