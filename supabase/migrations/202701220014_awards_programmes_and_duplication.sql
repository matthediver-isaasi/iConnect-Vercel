BEGIN;
CREATE FUNCTION public.awards_programme_command(p_tenant uuid,p_actor_kind text,p_actor uuid,
  p_id uuid,p_expected_version bigint,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE programme public.awards_programme;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL THEN RAISE EXCEPTION 'Actor required'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.awards_programme(tenant_id,name,description,cycle)
      VALUES(p_tenant,p_payload->>'name',coalesce(p_payload->>'description',''),coalesce(p_payload->>'cycle','')) RETURNING * INTO programme;
  ELSE
    SELECT * INTO programme FROM public.awards_programme WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Programme unavailable' USING ERRCODE='P0002'; END IF;
    IF programme.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Programme changed' USING ERRCODE='40001'; END IF;
    UPDATE public.awards_programme SET name=coalesce(p_payload->>'name',name),
      description=coalesce(p_payload->>'description',description),cycle=coalesce(p_payload->>'cycle',cycle),
      archived_at=CASE WHEN p_payload ? 'archived' THEN CASE WHEN (p_payload->>'archived')::boolean THEN now() ELSE NULL END ELSE archived_at END,
      version=version+1 WHERE id=programme.id RETURNING * INTO programme;
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,actor_kind,actor_id,action,subject_id,changes)
    VALUES(p_tenant,p_actor_kind,p_actor,'programme.configured',programme.id,jsonb_build_object('version',programme.version));
  RETURN to_jsonb(programme);
END $$;
CREATE FUNCTION public.awards_duplicate(p_tenant uuid,p_source uuid,p_expected_version bigint,
  p_actor_kind text,p_actor uuid,p_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source public.awards_competition; copy public.awards_competition; r public.assessment_round; new_round_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL THEN RAISE EXCEPTION 'Actor required'; END IF;
  SELECT * INTO source FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_source FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source award unavailable' USING ERRCODE='P0002'; END IF;
  IF source.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Source award changed' USING ERRCODE='40001'; END IF;
  INSERT INTO public.awards_competition(tenant_id,name,description,eligibility_information,timezone,amendments_enabled,retention_policy)
    VALUES(p_tenant,p_name,source.description,source.eligibility_information,source.timezone,source.amendments_enabled,source.retention_policy)
    RETURNING * INTO copy;
  INSERT INTO public.awards_form_binding(tenant_id,award_id,form_id,review_field_ids)
    SELECT p_tenant,copy.id,form_id,review_field_ids FROM public.awards_form_binding WHERE tenant_id=p_tenant AND award_id=source.id AND active;
  FOR r IN SELECT * FROM public.assessment_round WHERE tenant_id=p_tenant AND award_id=source.id ORDER BY position FOR SHARE LOOP
    INSERT INTO public.assessment_round(tenant_id,award_id,name,position,required_judges,require_all,visibility,
      comments_visible,moderation_required,moderation_methods,self_approval,moderation_proposers,moderation_approvers,moderation_discussion)
      VALUES(p_tenant,copy.id,r.name,r.position,r.required_judges,r.require_all,r.visibility,
        r.comments_visible,r.moderation_required,r.moderation_methods,r.self_approval,r.moderation_proposers,r.moderation_approvers,r.moderation_discussion) RETURNING id INTO new_round_id;
    INSERT INTO public.assessment_criteria_version(tenant_id,round_id,revision,definition)
      SELECT p_tenant,new_round_id,1,c.definition FROM public.assessment_criteria_version c
      WHERE c.tenant_id=p_tenant AND c.round_id=r.id ORDER BY c.revision DESC LIMIT 1;
  END LOOP;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,changes)
    VALUES(p_tenant,copy.id,p_actor_kind,p_actor,'award.duplicated',copy.id,jsonb_build_object('source_award_id',source.id));
  RETURN to_jsonb(copy)||jsonb_build_object('form_id',
    (SELECT form_id FROM public.awards_form_binding WHERE award_id=copy.id AND active),'review_field_ids',
    (SELECT review_field_ids FROM public.awards_form_binding WHERE award_id=copy.id AND active));
END $$;
REVOKE ALL ON FUNCTION public.awards_programme_command(uuid,text,uuid,uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_duplicate(uuid,uuid,bigint,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_programme_command(uuid,text,uuid,uuid,bigint,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_duplicate(uuid,uuid,bigint,text,uuid,text) TO service_role;
COMMIT;
