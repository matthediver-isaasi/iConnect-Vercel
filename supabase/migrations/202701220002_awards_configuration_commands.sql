BEGIN;
-- Tenant RBAC is checked by the server before invoking these service-only RPCs.
-- Actor metadata is supplied only by that authenticated server, never a browser.
CREATE FUNCTION public.awards_configure(
  p_tenant uuid, p_actor_kind text, p_actor uuid, p_command text,
  p_id uuid, p_expected_version bigint, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.awards_competition; old_state text; target text; programme uuid; result_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL THEN RAISE EXCEPTION 'Authenticated actor required'; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'Object payload required'; END IF;
  IF p_command='create' THEN
    programme:=nullif(p_payload->>'programme_id','')::uuid;
    INSERT INTO public.awards_competition(tenant_id,programme_id,name,description,cycle,timezone)
      VALUES(p_tenant,programme,p_payload->>'name',coalesce(p_payload->>'description',''),coalesce(p_payload->>'cycle',''),
        coalesce(p_payload->>'timezone','UTC')) RETURNING * INTO a;
  ELSE
    SELECT * INTO a FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Award unavailable' USING ERRCODE='P0002'; END IF;
    IF a.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Award changed; reload before continuing' USING ERRCODE='40001'; END IF;
    IF p_command='configure' THEN
      IF a.state<>'draft' THEN RAISE EXCEPTION 'Configuration is locked outside draft'; END IF;
      UPDATE public.awards_competition SET
        name=coalesce(p_payload->>'name',name),
        programme_id=CASE WHEN p_payload ? 'programme_id' THEN (p_payload->>'programme_id')::uuid ELSE programme_id END,
        description=coalesce(p_payload->>'description',description),
        cycle=coalesce(p_payload->>'cycle',cycle),
        eligibility_information=coalesce(p_payload->>'eligibility_information',eligibility_information),
        opens_at=CASE WHEN p_payload ? 'opens_at' THEN (p_payload->>'opens_at')::timestamptz ELSE opens_at END,
        closes_at=CASE WHEN p_payload ? 'closes_at' THEN (p_payload->>'closes_at')::timestamptz ELSE closes_at END,
        timezone=coalesce(p_payload->>'timezone',timezone),
        amendments_enabled=coalesce((p_payload->>'amendments_enabled')::boolean,amendments_enabled),
        retention_policy=CASE WHEN p_payload ? 'retention_policy' THEN p_payload->'retention_policy' ELSE retention_policy END,
        version=version+1
      WHERE id=a.id RETURNING * INTO a;
    ELSIF p_command='bind_form' THEN
      IF a.state<>'draft' THEN RAISE EXCEPTION 'Form binding is locked outside draft'; END IF;
      UPDATE public.awards_form_binding SET active=false WHERE award_id=a.id AND active;
      IF p_payload ? 'review_field_ids' AND jsonb_typeof(p_payload->'review_field_ids') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Review fields must be an explicit list'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p_payload->'review_field_ids','[]')) selected(id)
        WHERE NOT EXISTS(SELECT 1 FROM public.form f,jsonb_array_elements(coalesce(f.fields,'[]')) field
          WHERE f.id=(p_payload->>'form_id')::uuid AND f.tenant_id=p_tenant AND field->>'id'=selected.id)) THEN
        RAISE EXCEPTION 'Review field does not belong to the selected form'; END IF;
      INSERT INTO public.awards_form_binding(tenant_id,award_id,form_id,review_field_ids)
        VALUES(p_tenant,a.id,(p_payload->>'form_id')::uuid,
          ARRAY(SELECT jsonb_array_elements_text(coalesce(p_payload->'review_field_ids','[]')))) RETURNING id INTO result_id;
      UPDATE public.awards_competition SET version=version+1 WHERE id=a.id RETURNING * INTO a;
    ELSIF p_command='transition' THEN
      old_state:=a.state; target:=p_payload->>'state';
      IF NOT ((old_state='draft' AND target='open') OR (old_state='open' AND target='closed')
        OR (old_state='closed' AND target='judging')
        OR (old_state='judging' AND target='moderation')
        OR (old_state='moderation' AND target='shortlisting')
        OR (old_state='shortlisting' AND target='results_approved')
        OR (old_state='results_approved' AND target='completed')
        OR (old_state='completed' AND target='archived')) THEN RAISE EXCEPTION 'Unsupported award transition'; END IF;
      IF target IN ('judging','moderation','shortlisting','results_approved','completed')
        AND NOT public.awards_lifecycle_ready(p_tenant,a.id,target) THEN RAISE EXCEPTION 'Required round or outcome evidence is incomplete'; END IF;
      IF length(btrim(coalesce(p_payload->>'reason','')))=0 THEN RAISE EXCEPTION 'Transition reason required'; END IF;
      IF target='open' THEN
        IF a.opens_at IS NULL OR a.closes_at IS NULL OR a.closes_at<=now() THEN RAISE EXCEPTION 'Valid application window required'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.awards_form_binding b JOIN public.form f ON f.id=b.form_id
          WHERE b.award_id=a.id AND b.tenant_id=p_tenant AND b.active AND f.tenant_id=p_tenant AND f.is_active) THEN
          RAISE EXCEPTION 'An active same-tenant application form is required';
        END IF;
        IF jsonb_typeof(a.retention_policy) IS DISTINCT FROM 'object'
          OR coalesce((a.retention_policy->>'retention_days')::integer,0)<=0
          OR length(btrim(coalesce(a.retention_policy->>'disposal_authority','')))=0
          OR length(btrim(coalesce(a.retention_policy->>'legal_hold_policy','')))=0 THEN
          RAISE EXCEPTION 'Tenant retention and legal-hold policy required';
        END IF;
      END IF;
      UPDATE public.awards_competition SET state=target,version=version+1 WHERE id=a.id RETURNING * INTO a;
    ELSE RAISE EXCEPTION 'Unknown award command';
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=a.timezone) THEN RAISE EXCEPTION 'Invalid award timezone'; END IF;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,a.id,p_actor_kind,p_actor,p_command,a.id,p_payload->>'reason',
      jsonb_strip_nulls(jsonb_build_object('version',a.version,'from_state',old_state,'state',a.state,'binding_id',result_id)));
  RETURN to_jsonb(a) || jsonb_build_object('form_id',
    (SELECT b.form_id FROM public.awards_form_binding b WHERE b.award_id=a.id AND b.active),'review_field_ids',
    (SELECT b.review_field_ids FROM public.awards_form_binding b WHERE b.award_id=a.id AND b.active));
END $$;
REVOKE ALL ON FUNCTION public.awards_configure(uuid,text,uuid,text,uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_configure(uuid,text,uuid,text,uuid,bigint,jsonb) TO service_role;
COMMIT;
