BEGIN;
CREATE TABLE public.awards_certificate_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  series_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 300),
  source_pdf bytea NOT NULL CHECK(octet_length(source_pdf) BETWEEN 1 AND 10485760),
  placeholders jsonb NOT NULL CHECK(jsonb_typeof(placeholders)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,series_id,revision)
);
ALTER TABLE public.awards_certificate_template ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.awards_certificate_template FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.awards_certificate_template TO service_role;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON public.awards_certificate_template
FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence();
ALTER TABLE public.awards_certificate_issue ADD COLUMN pdf_bytes bytea NOT NULL;
ALTER TABLE public.awards_certificate_issue ADD COLUMN template_id uuid;
ALTER TABLE public.awards_certificate_issue ADD FOREIGN KEY(tenant_id,template_id) REFERENCES public.awards_certificate_template(tenant_id,id);
CREATE TABLE public.awards_certificate_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,issue_id) REFERENCES public.awards_certificate_issue(tenant_id,id)
);
ALTER TABLE public.awards_certificate_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.awards_certificate_access FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.awards_certificate_access TO service_role;
CREATE FUNCTION public.awards_save_certificate_template(p_tenant uuid,p_series uuid,p_revision integer,p_name text,p_hex text,p_placeholders jsonb,p_actor_kind text,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE series uuid:=coalesce(p_series,gen_random_uuid()); latest integer; saved public.awards_certificate_template;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(p_hex)>20971520 THEN RAISE EXCEPTION 'Template authority or size invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':certificate:'||series::text,0));
  SELECT coalesce(max(revision),0) INTO latest FROM public.awards_certificate_template WHERE tenant_id=p_tenant AND series_id=series;
  IF latest IS DISTINCT FROM p_revision OR p_series IS NOT NULL AND latest=0 THEN RAISE EXCEPTION 'Template changed or unavailable' USING ERRCODE='40001'; END IF;
  INSERT INTO public.awards_certificate_template(tenant_id,series_id,revision,name,source_pdf,placeholders)
    VALUES(p_tenant,series,latest+1,p_name,decode(p_hex,'hex'),p_placeholders) RETURNING * INTO saved;
  INSERT INTO public.awards_audit_event(tenant_id,actor_kind,actor_id,action,subject_id,changes)
    VALUES(p_tenant,p_actor_kind,p_actor,'certificate.template_saved',saved.id,jsonb_build_object('revision',saved.revision,'series_id',series));
  RETURN jsonb_build_object('id',saved.id,'series_id',series,'revision',saved.revision,'name',saved.name,'placeholders',saved.placeholders);
END $$;
CREATE FUNCTION public.awards_issue_certificate(p_tenant uuid,p_outcome uuid,p_template uuid,p_recipient jsonb,p_hex text,p_digest text,
  p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE outcome public.awards_outcome_revision; template public.awards_certificate_template; issued public.awards_certificate_issue; latest uuid; bytes bytea;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0
    OR jsonb_typeof(p_recipient) IS DISTINCT FROM 'object' OR length(p_hex)>52428800 THEN RAISE EXCEPTION 'Generation approval required'; END IF;
  SELECT * INTO outcome FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND id=p_outcome;
  IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable'; END IF;
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND id=outcome.round_id FOR UPDATE;
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=outcome.application_id FOR UPDATE;
  SELECT id INTO latest FROM public.awards_outcome_revision WHERE tenant_id=p_tenant AND application_id=outcome.application_id ORDER BY revision DESC LIMIT 1;
  IF outcome.state<>'approved' OR latest<>outcome.id OR coalesce((outcome.category_snapshot->>'certificate_enabled')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Current approved certificate-enabled outcome required'; END IF;
  IF NOT public.awards_outcome_is_current(p_tenant,outcome.id) THEN RAISE EXCEPTION 'Approved outcome evidence changed; review before certificate generation'; END IF;
  SELECT * INTO template FROM public.awards_certificate_template WHERE tenant_id=p_tenant AND id=p_template;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template unavailable'; END IF;
  SELECT * INTO issued FROM public.awards_certificate_issue WHERE tenant_id=p_tenant AND outcome_revision_id=outcome.id;
  IF FOUND THEN RETURN jsonb_build_object('id',issued.id,'replayed',true); END IF;
  bytes:=decode(p_hex,'hex');
  IF octet_length(bytes)<5 OR substring(bytes FROM 1 FOR 5)<>convert_to('%PDF-','UTF8')
    OR encode(sha256(bytes),'hex') IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'Certificate checksum or PDF invalid'; END IF;
  INSERT INTO public.awards_certificate_issue(tenant_id,award_id,outcome_revision_id,template_id,template_snapshot,recipient_snapshot,
    private_path,pdf_sha256,pdf_bytes,actor_kind,actor_id)
    VALUES(p_tenant,outcome.award_id,outcome.id,template.id,
      jsonb_build_object('id',template.id,'series_id',template.series_id,'revision',template.revision,'name',template.name,'placeholders',template.placeholders),
      p_recipient,p_tenant::text||'/awards-certificates/'||outcome.id::text||'.pdf',p_digest,bytes,p_actor_kind,p_actor) RETURNING * INTO issued;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,outcome.award_id,p_actor_kind,p_actor,'certificate.issued',issued.id,p_reason,jsonb_build_object('outcome_id',outcome.id,'template_id',template.id));
  RETURN jsonb_build_object('id',issued.id,'replayed',false);
END $$;
CREATE FUNCTION public.awards_read_certificate(p_tenant uuid,p_issue uuid,p_member uuid,p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE issued public.awards_certificate_issue; owner uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF num_nonnulls(p_member,p_token_hash)<>1 THEN RAISE EXCEPTION 'Recipient authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO issued FROM public.awards_certificate_issue WHERE tenant_id=p_tenant AND id=p_issue;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.awards_delivery_release WHERE tenant_id=p_tenant AND outcome_revision_id=issued.outcome_revision_id) THEN
    RAISE EXCEPTION 'Certificate not released' USING ERRCODE='42501'; END IF;
  IF p_member IS NOT NULL THEN
    SELECT a.member_id INTO owner FROM public.awards_application a JOIN public.awards_outcome_revision o ON o.application_id=a.id
      WHERE a.tenant_id=p_tenant AND o.id=issued.outcome_revision_id;
    IF owner IS DISTINCT FROM p_member THEN RAISE EXCEPTION 'Certificate unavailable' USING ERRCODE='42501'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.awards_certificate_access WHERE tenant_id=p_tenant AND issue_id=issued.id
    AND token_hash=p_token_hash AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Certificate link unavailable' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('hex',encode(issued.pdf_bytes,'hex'),'sha256',issued.pdf_sha256);
END $$;
REVOKE ALL ON FUNCTION public.awards_save_certificate_template(uuid,uuid,integer,text,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_issue_certificate(uuid,uuid,uuid,jsonb,text,text,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_read_certificate(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_save_certificate_template(uuid,uuid,integer,text,text,jsonb,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_issue_certificate(uuid,uuid,uuid,jsonb,text,text,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_read_certificate(uuid,uuid,uuid,text) TO service_role;
COMMIT;
