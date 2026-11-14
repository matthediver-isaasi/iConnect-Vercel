BEGIN;
CREATE FUNCTION public.assessment_session_logout(p_tenant uuid,p_session_hash text,p_csrf_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.assessment_session; a public.assessment_appointment; award uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM public.assessment_session WHERE tenant_id=p_tenant AND token_hash=p_session_hash;
  IF NOT FOUND OR s.csrf_hash IS DISTINCT FROM p_csrf_hash THEN RAISE EXCEPTION 'Session verification failed' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND id=s.round_id FOR UPDATE;
  SELECT * INTO a FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=s.appointment_id FOR UPDATE;
  SELECT * INTO s FROM public.assessment_session WHERE id=s.id FOR UPDATE;
  IF s.revoked_at IS NULL THEN
    UPDATE public.assessment_session SET revoked_at=clock_timestamp() WHERE id=s.id;
    SELECT award_id INTO award FROM public.assessment_round WHERE id=s.round_id;
    INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id)
      VALUES(p_tenant,award,'appointment',a.id,'session.signed_out',s.id);
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.assessment_session_logout(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_session_logout(uuid,text,text) TO service_role;
COMMIT;
