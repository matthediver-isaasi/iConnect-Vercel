BEGIN;
CREATE FUNCTION public.assessment_panel_dashboard(p_tenant uuid,p_member uuid,p_session_hash text,p_round uuid DEFAULT NULL,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE authority jsonb; panels jsonb; applications jsonb:='[]'; total integer; application_total integer:=0; j public.assessment_appointment;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF num_nonnulls(p_member,p_session_hash)<>1 OR p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Panel authority required' USING ERRCODE='42501'; END IF;
  IF p_member IS NULL THEN authority:=public.assessment_session_authority(p_tenant,p_session_hash); END IF;
  WITH owned AS (
    SELECT r.id round_id,r.name round_name,w.name award_name,r.state,r.closes_at,j.role FROM public.assessment_appointment j
      JOIN public.assessment_round r ON r.id=j.round_id JOIN public.awards_competition w ON w.id=r.award_id
      WHERE j.tenant_id=p_tenant AND j.state='accepted' AND (j.expires_at IS NULL OR j.expires_at>clock_timestamp())
        AND (j.member_id=p_member OR j.id=(authority->>'appointment_id')::uuid)
        AND j.role=ANY(r.moderation_discussion||r.moderation_proposers||r.moderation_approvers)
  ), selected AS (SELECT * FROM owned ORDER BY round_id LIMIT 25 OFFSET (p_page-1)*25)
  SELECT (SELECT count(*) FROM owned),coalesce(jsonb_agg(to_jsonb(selected) ORDER BY round_id),'[]') INTO total,panels FROM selected;
  IF p_round IS NOT NULL THEN
    j:=public.assessment_panel_authority(p_tenant,p_round,p_member,p_session_hash,NULL,false);
    IF NOT EXISTS(SELECT 1 FROM public.assessment_round r WHERE r.id=p_round
      AND j.role=ANY(r.moderation_discussion||r.moderation_proposers||r.moderation_approvers)) THEN
      RAISE EXCEPTION 'Panel role unavailable' USING ERRCODE='42501'; END IF;
    WITH eligible AS (
      SELECT a.id,a.reference,coalesce(c.state,'undeclared') conflict,coalesce(c.version,0) conflict_version,s.conflict assignment_conflict
        FROM public.awards_application a JOIN public.assessment_round r ON r.award_id=a.award_id AND r.id=p_round
        LEFT JOIN public.assessment_panel_conflict c ON c.appointment_id=j.id AND c.application_id=a.id
        LEFT JOIN public.assessment_assignment s ON s.appointment_id=j.id AND s.application_id=a.id
        WHERE a.tenant_id=p_tenant AND a.eligibility='eligible' AND public.assessment_round_candidate(p_tenant,r.id,a.id)
    ), selected AS (SELECT * FROM eligible ORDER BY id LIMIT 25 OFFSET (p_page-1)*25)
    SELECT (SELECT count(*) FROM eligible),coalesce(jsonb_agg(to_jsonb(selected) ORDER BY id),'[]') INTO application_total,applications FROM selected;
  END IF;
  RETURN jsonb_build_object('panels',panels,'total',total,'applications',applications,'applicationTotal',application_total,'page',p_page,'pageSize',25);
END $$;
CREATE FUNCTION public.assessment_panel_review_conflict(p_tenant uuid,p_conflict uuid,p_version bigint,p_actor_kind text,p_actor uuid,p_state text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.assessment_panel_conflict; r public.assessment_round; j public.assessment_appointment;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR p_state NOT IN ('cleared','confirmed')
    OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Conflict review authority and reason required'; END IF;
  SELECT * INTO c FROM public.assessment_panel_conflict WHERE tenant_id=p_tenant AND id=p_conflict;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conflict unavailable'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=c.round_id FOR UPDATE;
  SELECT * INTO j FROM public.assessment_appointment WHERE tenant_id=p_tenant AND id=c.appointment_id FOR UPDATE;
  SELECT * INTO c FROM public.assessment_panel_conflict WHERE tenant_id=p_tenant AND id=p_conflict FOR UPDATE;
  IF c.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Conflict changed' USING ERRCODE='40001'; END IF;
  IF public.assessment_actor_keys(p_tenant,'appointment',j.id)&&public.assessment_actor_keys(p_tenant,p_actor_kind,p_actor) THEN
    RAISE EXCEPTION 'A separate administrator must review your conflict'; END IF;
  UPDATE public.assessment_panel_conflict SET state=p_state,reason=p_reason,version=version+1 WHERE id=c.id RETURNING * INTO c;
  IF p_state='confirmed' THEN
    UPDATE public.assessment_assignment SET state='recused',conflict='confirmed',conflict_reason=p_reason,version=version+1
      WHERE tenant_id=p_tenant AND appointment_id=j.id AND application_id=c.application_id;
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'panel.conflict_reviewed',c.id,p_reason,jsonb_build_object('state',c.state,'version',c.version));
  RETURN jsonb_build_object('id',c.id,'state',c.state,'version',c.version);
END $$;
REVOKE ALL ON FUNCTION public.assessment_panel_dashboard(uuid,uuid,text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_panel_review_conflict(uuid,uuid,bigint,text,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_panel_dashboard(uuid,uuid,text,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_panel_review_conflict(uuid,uuid,bigint,text,uuid,text,text) TO service_role;
COMMIT;
