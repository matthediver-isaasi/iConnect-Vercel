BEGIN;
CREATE FUNCTION public.assessment_confirm_allocation(
  p_tenant uuid,p_round uuid,p_expected_version bigint,p_actor_kind text,p_actor uuid,p_pairs jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; pair jsonb; a public.awards_application;
  appointment public.assessment_appointment; snapshot uuid; criteria uuid; assignment uuid; created_ids uuid[]:='{}';
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR jsonb_typeof(p_pairs) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_pairs)>500 THEN RAISE EXCEPTION 'Invalid allocation confirmation'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=r.award_id FOR UPDATE;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR UPDATE;
  IF r.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Round changed; preview allocation again' USING ERRCODE='40001'; END IF;
  IF r.state NOT IN ('draft','judging') THEN RAISE EXCEPTION 'Round allocation is closed'; END IF;
  SELECT id INTO criteria FROM public.assessment_criteria_version WHERE tenant_id=p_tenant AND round_id=r.id ORDER BY revision DESC LIMIT 1;
  IF criteria IS NULL THEN RAISE EXCEPTION 'Configure criteria before allocation'; END IF;
  -- Lock all affected applications before appointments, in stable ID order.
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=r.award_id
    AND id IN (SELECT (value->>'applicationId')::uuid FROM jsonb_array_elements(p_pairs)) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.assessment_appointment WHERE tenant_id=p_tenant AND round_id=r.id
    AND id IN (SELECT (value->>'appointmentId')::uuid FROM jsonb_array_elements(p_pairs)) ORDER BY id FOR UPDATE;
  FOR pair IN SELECT value FROM jsonb_array_elements(p_pairs) LOOP
    SELECT * INTO a FROM public.awards_application
      WHERE tenant_id=p_tenant AND award_id=r.award_id AND id=(pair->>'applicationId')::uuid;
    IF NOT FOUND OR a.eligibility<>'eligible' THEN RAISE EXCEPTION 'Application unavailable for allocation'; END IF;
    IF public.assessment_has_active_decisions(p_tenant,r.id,a.id) THEN
      RAISE EXCEPTION 'Reopen downstream decisions before changing the panel'; END IF;
    SELECT * INTO appointment FROM public.assessment_appointment
      WHERE tenant_id=p_tenant AND round_id=r.id AND id=(pair->>'appointmentId')::uuid;
    IF NOT FOUND OR appointment.state<>'accepted' OR NOT appointment.available OR appointment.role NOT IN ('judge','chair')
      OR appointment.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Judge unavailable for allocation'; END IF;
    IF EXISTS(SELECT 1 FROM public.assessment_panel_conflict WHERE tenant_id=p_tenant AND appointment_id=appointment.id
      AND application_id=a.id AND state IN ('potential','confirmed')) THEN RAISE EXCEPTION 'Panel conflict prevents allocation'; END IF;
    IF (SELECT count(*) FROM public.assessment_assignment WHERE appointment_id=appointment.id AND state='assigned')>=appointment.capacity THEN
      RAISE EXCEPTION 'Judge capacity changed; preview allocation again'; END IF;
    SELECT id INTO snapshot FROM public.awards_application_version WHERE tenant_id=p_tenant AND application_id=a.id ORDER BY revision DESC LIMIT 1;
    IF snapshot IS NULL THEN RAISE EXCEPTION 'Immutable application version required'; END IF;
    IF snapshot IS DISTINCT FROM (pair->>'applicationVersionId')::uuid
      OR criteria IS DISTINCT FROM (pair->>'criteriaVersionId')::uuid THEN
      RAISE EXCEPTION 'Review versions changed; preview allocation again' USING ERRCODE='40001'; END IF;
    IF EXISTS(SELECT 1 FROM public.assessment_assignment
      WHERE round_id=r.id AND application_id=a.id AND state='assigned'
      AND (application_version_id<>snapshot OR criteria_version_id<>criteria)) THEN
      RAISE EXCEPTION 'Existing assignments use a different review version';
    END IF;
    -- Unique round/person/application key also prevents resurrecting a removed
    -- or conflicted assignment through allocation instead of its audited review.
    INSERT INTO public.assessment_assignment(tenant_id,award_id,round_id,appointment_id,application_id,application_version_id,criteria_version_id)
      VALUES(p_tenant,r.award_id,r.id,appointment.id,a.id,snapshot,criteria) RETURNING id INTO assignment;
    created_ids:=array_append(created_ids,assignment);
    INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,changes)
      VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'assignment.created',assignment,
        jsonb_build_object('application_id',a.id,'appointment_id',appointment.id,'application_version_id',snapshot,'criteria_version_id',criteria));
  END LOOP;
  UPDATE public.assessment_round SET version=version+1 WHERE id=r.id RETURNING * INTO r;
  RETURN jsonb_build_object('assignment_ids',created_ids,'round_version',r.version);
END $$;

CREATE FUNCTION public.assessment_declare_conflict(
  p_tenant uuid,p_assignment uuid,p_member uuid,p_session_hash text,p_csrf_hash text,
  p_expected_version bigint,p_conflict text,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE link public.assessment_assignment; appointment public.assessment_appointment; s public.assessment_session;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF num_nonnulls(p_member,p_session_hash)<>1 OR p_conflict NOT IN ('none','potential','confirmed')
    OR (p_conflict<>'none' AND length(btrim(coalesce(p_reason,'')))=0) THEN RAISE EXCEPTION 'Conflict declaration and reason required'; END IF;
  SELECT * INTO link FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.assessment_round WHERE id=link.round_id AND tenant_id=p_tenant FOR UPDATE;
  PERFORM 1 FROM public.awards_application WHERE id=link.application_id AND tenant_id=p_tenant FOR UPDATE;
  SELECT * INTO appointment FROM public.assessment_appointment WHERE id=link.appointment_id AND tenant_id=p_tenant FOR UPDATE;
  SELECT * INTO link FROM public.assessment_assignment WHERE tenant_id=p_tenant AND id=p_assignment FOR UPDATE;
  IF p_member IS NOT NULL THEN
    IF appointment.member_id IS DISTINCT FROM p_member THEN RAISE EXCEPTION 'Assignment unavailable' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT * INTO s FROM public.assessment_session WHERE tenant_id=p_tenant AND appointment_id=appointment.id AND token_hash=p_session_hash;
    IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp()
      OR s.generation<>appointment.credential_generation OR s.csrf_hash IS DISTINCT FROM p_csrf_hash
      OR appointment.member_id IS NOT NULL THEN RAISE EXCEPTION 'Judging session unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  IF appointment.state<>'accepted' OR appointment.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Appointment unavailable' USING ERRCODE='42501'; END IF;
  IF link.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Assignment changed' USING ERRCODE='40001'; END IF;
  IF link.conflict IN ('potential','confirmed') THEN RAISE EXCEPTION 'Administrator review is required to clear a declared conflict'; END IF;
  UPDATE public.assessment_assignment SET conflict=p_conflict,conflict_reason=p_reason,
    state=CASE WHEN p_conflict='confirmed' THEN 'recused' ELSE state END,version=version+1 WHERE id=link.id RETURNING * INTO link;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,link.award_id,CASE WHEN p_member IS NULL THEN 'appointment' ELSE 'member' END,coalesce(p_member,appointment.id),
      'conflict.declared',link.id,p_reason,jsonb_build_object('conflict',p_conflict));
  RETURN jsonb_build_object('assignment_id',link.id,'version',link.version,'conflict',link.conflict,'state',link.state);
END $$;
REVOKE ALL ON FUNCTION public.assessment_confirm_allocation(uuid,uuid,bigint,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_declare_conflict(uuid,uuid,uuid,text,text,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_confirm_allocation(uuid,uuid,bigint,text,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_declare_conflict(uuid,uuid,uuid,text,text,bigint,text,text) TO service_role;
COMMIT;
