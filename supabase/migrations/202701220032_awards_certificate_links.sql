BEGIN;
ALTER TABLE public.awards_delivery ADD COLUMN requested_due_at timestamptz NOT NULL DEFAULT now();
CREATE FUNCTION public.awards_certificate_link(p_tenant uuid,p_issue uuid,p_hash text,p_expiry timestamptz,
  p_actor_kind text,p_actor uuid,p_revoke boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE issued public.awards_certificate_issue; access_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR p_revoke IS NULL THEN RAISE EXCEPTION 'Release authority required'; END IF;
  SELECT * INTO issued FROM public.awards_certificate_issue WHERE tenant_id=p_tenant AND id=p_issue FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Certificate unavailable'; END IF;
  IF p_revoke THEN
    UPDATE public.awards_certificate_access SET revoked_at=clock_timestamp() WHERE tenant_id=p_tenant AND issue_id=p_issue AND revoked_at IS NULL;
  ELSE
    IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_expiry IS NULL OR p_expiry<=clock_timestamp()
      OR p_expiry>clock_timestamp()+interval '30 days' OR NOT EXISTS(
        SELECT 1 FROM public.awards_delivery_release WHERE tenant_id=p_tenant AND outcome_revision_id=issued.outcome_revision_id
      ) THEN RAISE EXCEPTION 'Released certificate and a valid scoped expiry required'; END IF;
    INSERT INTO public.awards_certificate_access(tenant_id,issue_id,token_hash,expires_at)
      VALUES(p_tenant,p_issue,p_hash,p_expiry) RETURNING id INTO access_id;
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,changes)
    VALUES(p_tenant,issued.award_id,p_actor_kind,p_actor,
      CASE WHEN p_revoke THEN 'certificate.links_revoked' ELSE 'certificate.link_created' END,p_issue,jsonb_build_object('expires_at',p_expiry));
  RETURN jsonb_build_object('access_id',access_id,'revoked',p_revoke);
END $$;
REVOKE ALL ON FUNCTION public.awards_certificate_link(uuid,uuid,text,timestamptz,text,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_certificate_link(uuid,uuid,text,timestamptz,text,uuid,boolean) TO service_role;
COMMIT;
