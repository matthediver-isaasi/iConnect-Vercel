BEGIN;
CREATE FUNCTION public.awards_applicant_certificate(p_tenant uuid,p_application uuid,p_hash text,p_issue uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE issued public.awards_certificate_issue;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application FOR SHARE;
  IF public.awards_external_applicant(p_tenant,p_application,p_hash) IS NULL THEN
    RAISE EXCEPTION 'Applicant access expired, revoked or unavailable' USING ERRCODE='42501'; END IF;
  SELECT certificate.* INTO issued FROM public.awards_certificate_issue certificate
    JOIN public.awards_outcome_revision outcome ON outcome.id=certificate.outcome_revision_id AND outcome.tenant_id=certificate.tenant_id
    WHERE certificate.tenant_id=p_tenant AND certificate.id=p_issue AND outcome.application_id=p_application
      AND EXISTS(SELECT 1 FROM public.awards_delivery_release release WHERE release.tenant_id=p_tenant AND release.outcome_revision_id=outcome.id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Released certificate unavailable' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('hex',encode(issued.pdf_bytes,'hex'),'sha256',issued.pdf_sha256);
END $$;
REVOKE ALL ON FUNCTION public.awards_applicant_certificate(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_applicant_certificate(uuid,uuid,text,uuid) TO service_role;
COMMIT;
