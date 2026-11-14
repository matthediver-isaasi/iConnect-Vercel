BEGIN;
CREATE FUNCTION public.assessment_read_attachment(p_tenant uuid,p_assignment uuid,p_attachment uuid,p_member uuid,p_session_hash text,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.assessment_assignment; appointment public.assessment_appointment; authority jsonb; file public.awards_review_attachment;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF num_nonnulls(p_member,p_session_hash)<>1 THEN RAISE EXCEPTION 'Verified identity required' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attachment unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND id=s.round_id FOR SHARE;
  SELECT * INTO appointment FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=s.appointment_id FOR SHARE;
  SELECT * INTO s FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment FOR SHARE;
  IF appointment.state<>'accepted' OR appointment.expires_at<=clock_timestamp() OR s.state<>'assigned'
    OR s.conflict NOT IN ('none','cleared') OR NOT EXISTS(SELECT 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=s.application_id AND eligibility='eligible') THEN
    RAISE EXCEPTION 'Assignment access withdrawn' USING ERRCODE='42501'; END IF;
  IF p_member IS NOT NULL THEN
    IF appointment.member_id IS DISTINCT FROM p_member THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  ELSE
    authority:=public.assessment_session_authority(p_tenant,p_session_hash);
    IF (authority->>'appointment_id')::uuid IS DISTINCT FROM appointment.id THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.awards_application_version v,jsonb_array_elements(v.attachment_manifest) attachment
    WHERE v.tenant_id=p_tenant AND v.id=s.application_version_id AND attachment->>'id'=p_attachment::text) THEN
    RAISE EXCEPTION 'Attachment unavailable' USING ERRCODE='P0002'; END IF;
  SELECT * INTO file FROM public.awards_review_attachment WHERE tenant_id=p_tenant AND id=p_attachment;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attachment unavailable' USING ERRCODE='P0002'; END IF;
  RETURN public.awards_attachment_chunk(p_tenant,s.application_version_id,p_attachment,p_offset);
END $$;
REVOKE ALL ON FUNCTION public.assessment_read_attachment(uuid,uuid,uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_read_attachment(uuid,uuid,uuid,uuid,text,integer) TO service_role;
COMMIT;
