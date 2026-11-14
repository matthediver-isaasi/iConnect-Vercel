BEGIN;
CREATE FUNCTION public.assessment_configure_round(
  p_tenant uuid,p_award uuid,p_round uuid,p_expected_version bigint,p_actor_kind text,p_actor uuid,
  p_command text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; criteria_id uuid; person uuid; email_address text; contact uuid; app uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Authenticated actor and payload required'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_award AND state NOT IN ('completed','archived') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award unavailable' USING ERRCODE='P0002'; END IF;
  IF p_command='create' THEN
    INSERT INTO public.assessment_round(tenant_id,award_id,name,position)
      SELECT p_tenant,p_award,p_payload->>'name',coalesce(max(position),0)+1 FROM public.assessment_round WHERE award_id=p_award
      RETURNING * INTO r;
  ELSE
    SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND award_id=p_award AND id=p_round FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Round unavailable' USING ERRCODE='P0002'; END IF;
    IF r.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Round changed; reload before continuing' USING ERRCODE='40001'; END IF;
    IF p_command='configure' THEN
      IF r.state<>'draft' THEN RAISE EXCEPTION 'Round configuration is locked'; END IF;
      UPDATE public.assessment_round SET name=coalesce(p_payload->>'name',name),
        opens_at=CASE WHEN p_payload ? 'opens_at' THEN (p_payload->>'opens_at')::timestamptz ELSE opens_at END,
        closes_at=CASE WHEN p_payload ? 'closes_at' THEN (p_payload->>'closes_at')::timestamptz ELSE closes_at END,
        required_judges=coalesce((p_payload->>'required_judges')::integer,required_judges),
        require_all=coalesce((p_payload->>'require_all')::boolean,require_all),
        visibility=coalesce(p_payload->>'visibility',visibility),
        comments_visible=coalesce((p_payload->>'comments_visible')::boolean,comments_visible),
        moderation_required=coalesce((p_payload->>'moderation_required')::boolean,moderation_required),
        self_approval=coalesce((p_payload->>'self_approval')::boolean,self_approval),
        version=version+1 WHERE id=r.id RETURNING * INTO r;
    ELSIF p_command='criteria' THEN
      IF r.state<>'draft' OR EXISTS(SELECT 1 FROM public.assessment_assignment WHERE round_id=r.id) THEN
        RAISE EXCEPTION 'Criteria are locked after allocation; use a fresh round'; END IF;
      -- Server validates the complete definition with the reusable scoring
      -- validator before this service-only command.
      IF jsonb_typeof(p_payload->'definition') IS DISTINCT FROM 'object'
        OR p_payload->'definition'->>'optionalPolicy' NOT IN ('incomplete','renormalise') THEN RAISE EXCEPTION 'Explicit scoring policy required'; END IF;
      IF p_payload->>'template_version_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.assessment_scoring_template
        WHERE tenant_id=p_tenant AND id=(p_payload->>'template_version_id')::uuid AND definition=p_payload->'definition') THEN
        RAISE EXCEPTION 'Scoring template version does not match this definition'; END IF;
      INSERT INTO public.assessment_criteria_version(tenant_id,round_id,revision,definition,template_version_id)
        SELECT p_tenant,r.id,coalesce(max(revision),0)+1,p_payload->'definition',(p_payload->>'template_version_id')::uuid
        FROM public.assessment_criteria_version WHERE round_id=r.id RETURNING id INTO criteria_id;
      UPDATE public.assessment_round SET version=version+1 WHERE id=r.id RETURNING * INTO r;
    ELSIF p_command='appoint' THEN
      person:=nullif(p_payload->>'member_id','')::uuid;
      contact:=nullif(p_payload->>'contact_id','')::uuid;
      email_address:=nullif(lower(btrim(p_payload->>'external_email')),'');
      IF num_nonnulls(person,contact,email_address)<>1 THEN RAISE EXCEPTION 'Select one judge identity'; END IF;
      -- Serialize email-based appointment creation within a round. Existing
      -- canonical member/contact matches require explicit identity selection.
      IF email_address IS NOT NULL THEN
        IF EXISTS(SELECT 1 FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
          WHERE coalesce(m.tenant_id,o.tenant_id)=p_tenant AND lower(btrim(m.email))=email_address) THEN
          RAISE EXCEPTION 'Select the existing member for this email';
        END IF;
        IF EXISTS(SELECT 1 FROM public.organization_contact c JOIN public.organization o ON o.id=c.organization_id
          WHERE o.tenant_id=p_tenant AND lower(btrim(c.email))=email_address) THEN
          RAISE EXCEPTION 'Select the existing organisation contact for this email';
        END IF;
      END IF;
      IF contact IS NOT NULL THEN
        SELECT lower(btrim(c.email)) INTO email_address FROM public.organization_contact c
          JOIN public.organization o ON o.id=c.organization_id WHERE c.id=contact AND o.tenant_id=p_tenant;
        IF NOT FOUND THEN RAISE EXCEPTION 'Contact unavailable'; END IF;
        IF EXISTS(SELECT 1 FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
          WHERE coalesce(m.tenant_id,o.tenant_id)=p_tenant AND lower(btrim(m.email))=email_address) THEN
          RAISE EXCEPTION 'Select the existing member for this contact email';
        END IF;
      ELSIF person IS NOT NULL THEN
        SELECT lower(btrim(m.email)) INTO email_address FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
          WHERE m.id=person AND coalesce(m.tenant_id,o.tenant_id)=p_tenant;
        IF NOT FOUND THEN RAISE EXCEPTION 'Member unavailable'; END IF;
      END IF;
      IF EXISTS(SELECT 1 FROM public.assessment_appointment a
        LEFT JOIN public.member m ON m.id=a.member_id LEFT JOIN public.organization_contact c ON c.id=a.contact_id
        WHERE a.round_id=r.id AND coalesce(a.external_email,lower(btrim(m.email)),lower(btrim(c.email)))=email_address) THEN
        RAISE EXCEPTION 'This email already has a round appointment' USING ERRCODE='23505';
      END IF;
      INSERT INTO public.assessment_appointment(tenant_id,round_id,member_id,contact_id,external_email,external_name,role,capacity,expires_at)
        VALUES(p_tenant,r.id,person,contact,CASE WHEN person IS NULL AND contact IS NULL THEN email_address ELSE NULL END,
          CASE WHEN person IS NULL AND contact IS NULL THEN p_payload->>'external_name' ELSE NULL END,
          coalesce(p_payload->>'role','judge'),coalesce((p_payload->>'capacity')::integer,100),(p_payload->>'expires_at')::timestamptz)
        RETURNING id INTO app;
      UPDATE public.assessment_round SET version=version+1 WHERE id=r.id RETURNING * INTO r;
    ELSIF p_command='start' THEN
      IF r.state<>'draft' OR r.opens_at IS NULL OR r.closes_at IS NULL OR r.closes_at<=clock_timestamp()
        OR clock_timestamp()<r.opens_at THEN RAISE EXCEPTION 'Round is outside its judging window'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.assessment_criteria_version WHERE round_id=r.id)
        OR NOT EXISTS(SELECT 1 FROM public.assessment_assignment WHERE round_id=r.id AND state='assigned') THEN
        RAISE EXCEPTION 'Criteria and assigned eligible applications are required'; END IF;
      UPDATE public.assessment_round SET state='judging',version=version+1 WHERE id=r.id RETURNING * INTO r;
    ELSE RAISE EXCEPTION 'Unknown round command';
    END IF;
  END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,p_award,p_actor_kind,p_actor,'round.'||p_command,r.id,p_payload->>'reason',
      jsonb_strip_nulls(jsonb_build_object('version',r.version,'criteria_version_id',criteria_id,'appointment_id',app)));
  RETURN to_jsonb(r)||jsonb_build_object('criteria_version_id',criteria_id,'appointment_id',app);
END $$;
REVOKE ALL ON FUNCTION public.assessment_configure_round(uuid,uuid,uuid,bigint,text,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_configure_round(uuid,uuid,uuid,bigint,text,uuid,text,jsonb) TO service_role;
COMMIT;
