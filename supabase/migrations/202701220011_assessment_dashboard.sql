BEGIN;
CREATE FUNCTION public.assessment_dashboard(p_tenant uuid,p_member uuid,p_session_hash text,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE session_authority jsonb; results jsonb; invitations jsonb; total integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF num_nonnulls(p_member,p_session_hash)<>1 OR p_page IS NULL OR p_page<1 OR p_page>10000 THEN RAISE EXCEPTION 'Invalid judging request'; END IF;
  IF p_session_hash IS NOT NULL THEN session_authority:=public.assessment_session_authority(p_tenant,p_session_hash); END IF;
  SELECT count(*) INTO total FROM public.assessment_assignment a
    JOIN public.assessment_appointment j ON j.id=a.appointment_id
    WHERE a.tenant_id=p_tenant AND j.tenant_id=p_tenant AND j.state='accepted'
      AND (j.expires_at IS NULL OR j.expires_at>clock_timestamp())
      AND (j.member_id=p_member OR j.id=(session_authority->>'appointment_id')::uuid);
  SELECT coalesce(jsonb_agg(row_data ORDER BY created_at DESC,id),'[]') INTO results FROM (
    SELECT a.id,a.created_at,jsonb_build_object(
      'id',a.id,'version',a.version,'state',a.state,'conflict',a.conflict,'included',a.included,
      'applicationReference',application.reference,'eligibility',application.eligibility,
      'roundId',r.id,'roundName',r.name,'awardName',award.name,'roundState',r.state,
      'deadline',r.closes_at,'assessmentState',latest.state,'assessmentRevision',coalesce(latest.revision,0)
    ) row_data FROM public.assessment_assignment a
    JOIN public.assessment_appointment j ON j.id=a.appointment_id AND j.tenant_id=p_tenant
    JOIN public.assessment_round r ON r.id=a.round_id AND r.tenant_id=p_tenant
    JOIN public.awards_competition award ON award.id=a.award_id AND award.tenant_id=p_tenant
    JOIN public.awards_application application ON application.id=a.application_id AND application.tenant_id=p_tenant
    LEFT JOIN LATERAL (SELECT state,revision FROM public.assessment_revision ar
      WHERE ar.tenant_id=p_tenant AND ar.assignment_id=a.id ORDER BY revision DESC LIMIT 1) latest ON true
    WHERE a.tenant_id=p_tenant AND j.state='accepted' AND (j.expires_at IS NULL OR j.expires_at>clock_timestamp())
      AND (j.member_id=p_member OR j.id=(session_authority->>'appointment_id')::uuid)
    ORDER BY a.created_at DESC,a.id LIMIT 25 OFFSET (p_page-1)*25
  ) rows;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',j.id,'version',j.version,'roundName',r.name,'awardName',a.name)
    ORDER BY j.created_at,j.id),'[]') INTO invitations FROM public.assessment_appointment j
    JOIN public.assessment_round r ON r.id=j.round_id AND r.tenant_id=p_tenant
    JOIN public.awards_competition a ON a.id=r.award_id AND a.tenant_id=p_tenant
    WHERE j.tenant_id=p_tenant AND j.member_id=p_member AND j.state='invited'
      AND (j.expires_at IS NULL OR j.expires_at>clock_timestamp());
  RETURN jsonb_build_object('assignments',results,'invitations',invitations,'total',total,'page',p_page,'pageSize',25);
END $$;
CREATE FUNCTION public.assessment_respond_member(p_tenant uuid,p_member uuid,p_appointment uuid,p_expected_version bigint,p_accept boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE appointment public.assessment_appointment;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO appointment FROM public.assessment_appointment
    WHERE tenant_id=p_tenant AND id=p_appointment AND member_id=p_member FOR UPDATE;
  IF NOT FOUND OR appointment.state<>'invited' OR appointment.expires_at<=clock_timestamp() OR p_accept IS NULL THEN
    RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501'; END IF;
  IF appointment.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Invitation changed' USING ERRCODE='40001'; END IF;
  UPDATE public.assessment_appointment SET state=CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,version=version+1
    WHERE id=appointment.id RETURNING * INTO appointment;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,changes)
    SELECT p_tenant,r.award_id,'member',p_member,'appointment.responded',appointment.id,jsonb_build_object('state',appointment.state)
      FROM public.assessment_round r WHERE r.id=appointment.round_id AND r.tenant_id=p_tenant;
  RETURN jsonb_build_object('id',appointment.id,'state',appointment.state,'version',appointment.version);
END $$;
REVOKE ALL ON FUNCTION public.assessment_dashboard(uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_respond_member(uuid,uuid,uuid,bigint,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_dashboard(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_respond_member(uuid,uuid,uuid,bigint,boolean) TO service_role;
COMMIT;
