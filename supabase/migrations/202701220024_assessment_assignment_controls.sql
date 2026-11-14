BEGIN;
CREATE FUNCTION public.assessment_assignment_command(p_tenant uuid,p_assignment uuid,p_version bigint,
  p_command text,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.assessment_assignment; a public.assessment_appointment; r public.assessment_round;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0
    OR p_command NOT IN ('remove','restore','exclude','include','clear_conflict','confirm_conflict') THEN RAISE EXCEPTION 'Valid assignment command and reason required'; END IF;
  SELECT * INTO s FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='P0002'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=s.round_id FOR UPDATE;
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=s.application_id FOR UPDATE;
  SELECT * INTO a FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=s.appointment_id FOR UPDATE;
  SELECT * INTO s FROM public.assessment_assignment WHERE id=s.id FOR UPDATE;
  IF s.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Assignment changed' USING ERRCODE='40001'; END IF;
  IF public.assessment_has_active_decisions(p_tenant,r.id,s.application_id) THEN RAISE EXCEPTION 'Reopen downstream decisions before changing assessment inclusion'; END IF;
  IF p_command IN ('include','restore','clear_conflict') THEN
    IF a.state<>'accepted' OR NOT EXISTS(SELECT 1 FROM public.awards_application WHERE id=s.application_id AND eligibility='eligible') THEN
      RAISE EXCEPTION 'Eligible application and accepted appointment required'; END IF;
  END IF;
  IF p_command='clear_conflict' THEN
    IF s.conflict NOT IN ('potential','confirmed') THEN RAISE EXCEPTION 'No declared conflict to review'; END IF;
    IF p_actor_kind='member' AND a.member_id=p_actor THEN RAISE EXCEPTION 'A different administrator must review this conflict'; END IF;
    UPDATE public.assessment_assignment SET conflict='cleared',conflict_reason=p_reason,version=version+1 WHERE id=s.id RETURNING * INTO s;
  ELSIF p_command='confirm_conflict' THEN
    UPDATE public.assessment_assignment SET conflict='confirmed',conflict_reason=p_reason,state='recused',included=false,
      inclusion_reason=p_reason,version=version+1 WHERE id=s.id RETURNING * INTO s;
  ELSIF p_command='include' THEN
    IF s.state<>'assigned' OR s.conflict NOT IN ('none','cleared') THEN RAISE EXCEPTION 'Resolve assignment and conflict before inclusion'; END IF;
    UPDATE public.assessment_assignment SET included=true,inclusion_reason=p_reason,version=version+1 WHERE id=s.id RETURNING * INTO s;
  ELSIF p_command='exclude' THEN
    UPDATE public.assessment_assignment SET included=false,inclusion_reason=p_reason,version=version+1 WHERE id=s.id RETURNING * INTO s;
  ELSIF p_command='remove' THEN
    UPDATE public.assessment_assignment SET state='removed',included=false,inclusion_reason=p_reason,version=version+1 WHERE id=s.id RETURNING * INTO s;
  ELSE
    IF s.state='assigned' OR s.conflict NOT IN ('none','cleared') THEN RAISE EXCEPTION 'Only a resolved removed or recused assignment can be restored'; END IF;
    IF r.state NOT IN ('draft','judging') OR r.closes_at IS NULL OR r.closes_at<=clock_timestamp() OR NOT a.available OR a.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Appointment or round unavailable'; END IF;
    IF a.capacity IS NOT NULL AND (SELECT count(*) FROM public.assessment_assignment WHERE appointment_id=a.id AND state='assigned')>=a.capacity THEN
      RAISE EXCEPTION 'Appointment capacity reached'; END IF;
    UPDATE public.assessment_assignment SET state='assigned',included=false,inclusion_reason=p_reason,version=version+1 WHERE id=s.id RETURNING * INTO s;
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,s.award_id,p_actor_kind,p_actor,'assignment.'||p_command,s.id,p_reason,
      jsonb_build_object('version',s.version,'state',s.state,'included',s.included,'conflict',s.conflict));
  RETURN jsonb_build_object('id',s.id,'version',s.version,'state',s.state,'included',s.included,'conflict',s.conflict);
END $$;
CREATE FUNCTION public.assessment_appointment_availability(p_tenant uuid,p_appointment uuid,p_version bigint,
  p_available boolean,p_capacity integer,p_expiry timestamptz,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.assessment_appointment; award uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR p_available IS NULL
    OR p_capacity IS NULL OR p_capacity NOT BETWEEN 0 AND 10000 OR p_expiry IS NULL OR p_expiry<=clock_timestamp() OR length(btrim(coalesce(p_reason,'')))=0 THEN
    RAISE EXCEPTION 'Availability, future expiry and reason required'; END IF;
  SELECT * INTO a FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=p_appointment;
  IF NOT FOUND THEN RAISE EXCEPTION 'Appointment unavailable' USING ERRCODE='P0002'; END IF;
  SELECT award_id INTO award FROM public.assessment_round WHERE tenant_id=p_tenant AND id=a.round_id FOR UPDATE;
  SELECT * INTO a FROM public.assessment_appointment WHERE id=a.id FOR UPDATE;
  IF a.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Appointment changed' USING ERRCODE='40001'; END IF;
  IF p_capacity IS NOT NULL AND p_capacity<(SELECT count(*) FROM public.assessment_assignment WHERE appointment_id=a.id AND state='assigned') THEN
    RAISE EXCEPTION 'Reassign existing workload before reducing capacity'; END IF;
  UPDATE public.assessment_appointment SET available=p_available,capacity=p_capacity,expires_at=p_expiry,version=version+1 WHERE id=a.id RETURNING * INTO a;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,award,p_actor_kind,p_actor,'appointment.availability',a.id,p_reason,
      jsonb_build_object('version',a.version,'available',a.available,'capacity',a.capacity,'expires_at',a.expires_at));
  RETURN jsonb_build_object('id',a.id,'version',a.version,'available',a.available,'capacity',a.capacity,'expires_at',a.expires_at);
END $$;
REVOKE ALL ON FUNCTION public.assessment_assignment_command(uuid,uuid,bigint,text,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_appointment_availability(uuid,uuid,bigint,boolean,integer,timestamptz,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_assignment_command(uuid,uuid,bigint,text,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_appointment_availability(uuid,uuid,bigint,boolean,integer,timestamptz,text,uuid,text) TO service_role;
COMMIT;
