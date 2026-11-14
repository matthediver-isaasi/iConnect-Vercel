BEGIN;
ALTER TABLE public.assessment_assignment ADD COLUMN decline_reason text;
CREATE FUNCTION public.assessment_decline_assignment(p_tenant uuid,p_assignment uuid,p_member uuid,p_session_hash text,p_csrf_hash text,p_version bigint,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.assessment_assignment; j public.assessment_appointment; latest text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF length(btrim(coalesce(p_reason,'')))=0 OR length(p_reason)>2000 THEN RAISE EXCEPTION 'Decline reason required'; END IF;
  SELECT * INTO s FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND id=s.round_id FOR UPDATE;
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=s.application_id FOR UPDATE;
  j:=public.assessment_panel_authority(p_tenant,s.round_id,p_member,p_session_hash,p_csrf_hash,true);
  IF j.id<>s.appointment_id THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment FOR UPDATE;
  IF s.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Assignment changed' USING ERRCODE='40001'; END IF;
  IF s.state<>'assigned' THEN RAISE EXCEPTION 'Assignment is not active'; END IF;
  SELECT state INTO latest FROM public.assessment_revision WHERE assignment_id=s.id ORDER BY revision DESC LIMIT 1;
  IF latest='submitted' OR public.assessment_has_active_decisions(p_tenant,s.round_id,s.application_id) THEN
    RAISE EXCEPTION 'Ask an administrator to review a completed assessment or downstream decision'; END IF;
  UPDATE public.assessment_assignment SET state='declined',decline_reason=p_reason,version=version+1 WHERE id=s.id RETURNING * INTO s;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,s.award_id,'appointment',j.id,'assignment.declined',s.id,p_reason,jsonb_build_object('version',s.version,'drafts','retained'));
  RETURN jsonb_build_object('id',s.id,'state',s.state,'version',s.version);
END $$;
REVOKE ALL ON FUNCTION public.assessment_decline_assignment(uuid,uuid,uuid,text,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_decline_assignment(uuid,uuid,uuid,text,text,bigint,text) TO service_role;
COMMIT;
