-- Opt-in foundation for authenticated form affiliation changes.
-- No form is enabled and no member data is changed by this migration.
BEGIN;

CREATE TABLE IF NOT EXISTS public.form_member_relationship_operation (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  submission_id uuid NOT NULL REFERENCES public.form_submission(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, submission_id)
);
ALTER TABLE public.form_member_relationship_operation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_member_relationship_operation FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.form_member_relationship_operation TO service_role;

-- Kept private even to service_role: the apply function owns the transaction.
CREATE OR REPLACE FUNCTION public.form_member_relationship_snapshot(
  p_tenant_id uuid, p_member_id uuid, p_definitions uuid[]
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'organization_id', m.organization_id,
    'relationships', COALESCE((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
      FROM public.custom_object_relationship r
      JOIN public.custom_object_relationship_definition d
        ON d.id=r.relationship_definition_id AND d.tenant_id=r.tenant_id
      WHERE r.tenant_id=p_tenant_id AND r.archived_at IS NULL
        AND d.id=ANY(p_definitions)
        AND ((d.source_kind='member' AND r.source_record_id=p_member_id)
          OR (d.target_kind='member' AND r.target_record_id=p_member_id))
    ), '[]'::jsonb))
  FROM public.member m WHERE m.tenant_id=p_tenant_id AND m.id=p_member_id
$$;
REVOKE ALL ON FUNCTION public.form_member_relationship_snapshot(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.form_member_relationship_apply(
  p_tenant_id uuid, p_submission_id uuid, p_member_id uuid,
  p_expected jsonb, p_organization_id uuid, p_sets jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_submission public.form_submission%ROWTYPE;
  v_form public.form%ROWTYPE;
  v_prior public.form_member_relationship_operation%ROWTYPE;
  v_definition public.custom_object_relationship_definition%ROWTYPE;
  v_request jsonb;
  v_definitions uuid[];
  v_set jsonb;
  v_ids uuid[];
  v_related uuid;
  v_member_source boolean;
  v_other_kind text;
  v_other_object uuid;
  v_current jsonb;
  v_result jsonb;
  v_added integer := 0;
  v_archived integer := 0;
  v_count integer;
BEGIN
  IF p_tenant_id IS NULL OR p_submission_id IS NULL OR p_member_id IS NULL
    OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_sets) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_sets)>30 THEN
    RAISE EXCEPTION 'Invalid affiliation request' USING ERRCODE='22023';
  END IF;
  v_request := jsonb_build_object('member_id',p_member_id,'expected',p_expected,
    'organization_id',p_organization_id,'sets',p_sets);

  -- Also protects against ordinary graph writers, which do not participate in
  -- a form-specific advisory lock. Small bounded transactions only.
  LOCK TABLE public.custom_object_relationship, public.custom_object_record
    IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_submission FROM public.form_submission
    WHERE id=p_submission_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_prior FROM public.form_member_relationship_operation
    WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id;
  IF FOUND THEN
    IF v_prior.member_id<>p_member_id OR v_prior.request<>v_request THEN
      RAISE EXCEPTION 'Submission already used for different affiliation changes' USING ERRCODE='23505';
    END IF;
    RETURN v_prior.result || jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO v_form FROM public.form
    WHERE id=v_submission.form_id AND tenant_id=p_tenant_id FOR SHARE;
  IF NOT FOUND OR v_form.require_authentication IS DISTINCT FROM true
    OR v_form.mutation_access_policy->>'mode' IS DISTINCT FROM 'authenticated_owner' THEN
    RAISE EXCEPTION 'Authenticated owner form required' USING ERRCODE='42501';
  END IF;
  -- The application must resolve the signed-in identity. The persisted
  -- submission is an independent binding, never a browser-supplied owner.
  IF v_submission.created_member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION 'Submission member mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=p_member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member unavailable' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NOT NULL THEN
    PERFORM 1 FROM public.organization WHERE tenant_id=p_tenant_id AND id=p_organization_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Organisation unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT COALESCE(array_agg((x->>'definition_id')::uuid ORDER BY x->>'definition_id'),'{}'::uuid[])
    INTO v_definitions FROM jsonb_array_elements(p_sets) x;
  IF array_position(v_definitions,NULL) IS NOT NULL
    OR cardinality(v_definitions)<>(SELECT count(DISTINCT x) FROM unnest(v_definitions) x) THEN
    RAISE EXCEPTION 'Duplicate or missing relationship definitions' USING ERRCODE='22023';
  END IF;
  v_current := public.form_member_relationship_snapshot(p_tenant_id,p_member_id,v_definitions);
  IF v_current IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'Affiliations changed; reload before saving' USING ERRCODE='40001';
  END IF;

  -- Validate all endpoints before changing anything. Existing relationship
  -- triggers remain enabled and enforce configured graph/cardinality rules.
  FOR v_set IN SELECT value FROM jsonb_array_elements(p_sets) LOOP
    SELECT * INTO v_definition FROM public.custom_object_relationship_definition
      WHERE id=(v_set->>'definition_id')::uuid AND tenant_id=p_tenant_id
        AND status='active' FOR SHARE;
    IF NOT FOUND OR (v_definition.source_kind='member')=(v_definition.target_kind='member') THEN
      RAISE EXCEPTION 'Relationship must have exactly one member endpoint' USING ERRCODE='42501';
    END IF;
    IF jsonb_typeof(v_set->'related_ids') IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_set->'related_ids')>500 THEN
      RAISE EXCEPTION 'Explicit bounded relationship selection required' USING ERRCODE='22023';
    END IF;
    SELECT COALESCE(array_agg(x::uuid),'{}'::uuid[]) INTO v_ids
      FROM jsonb_array_elements_text(v_set->'related_ids') x;
    IF array_position(v_ids,NULL) IS NOT NULL
      OR cardinality(v_ids)<>(SELECT count(DISTINCT x) FROM unnest(v_ids) x) THEN
      RAISE EXCEPTION 'Duplicate or missing related records' USING ERRCODE='22023';
    END IF;
    v_member_source := v_definition.source_kind='member';
    v_other_kind := CASE WHEN v_member_source THEN v_definition.target_kind ELSE v_definition.source_kind END;
    v_other_object := CASE WHEN v_member_source THEN v_definition.target_custom_object_id ELSE v_definition.source_custom_object_id END;
    FOREACH v_related IN ARRAY v_ids LOOP
      IF v_other_kind='custom_object' THEN
        PERFORM 1 FROM public.custom_object_record WHERE tenant_id=p_tenant_id
          AND id=v_related AND custom_object_id=v_other_object AND archived_at IS NULL FOR SHARE;
      ELSIF v_other_kind='organization' THEN
        PERFORM 1 FROM public.organization WHERE tenant_id=p_tenant_id AND id=v_related FOR SHARE;
      ELSIF v_other_kind='organization_group' THEN
        PERFORM 1 FROM public.organization_group WHERE tenant_id=p_tenant_id AND id=v_related FOR SHARE;
      ELSE
        RAISE EXCEPTION 'Unsupported affiliation endpoint' USING ERRCODE='22023';
      END IF;
      IF NOT FOUND THEN RAISE EXCEPTION 'Related record unavailable' USING ERRCODE='42501'; END IF;
    END LOOP;
  END LOOP;

  -- Archive removed links first. New links are validated against the final
  -- primary organisation, with rollback restoring old links on any failure.
  FOR v_set IN SELECT value FROM jsonb_array_elements(p_sets) LOOP
    SELECT * INTO STRICT v_definition FROM public.custom_object_relationship_definition
      WHERE id=(v_set->>'definition_id')::uuid AND tenant_id=p_tenant_id;
    SELECT COALESCE(array_agg(x::uuid),'{}'::uuid[]) INTO v_ids
      FROM jsonb_array_elements_text(v_set->'related_ids') x;
    UPDATE public.custom_object_relationship r SET archived_at=now(),archived_by=p_member_id::text
      WHERE tenant_id=p_tenant_id AND relationship_definition_id=v_definition.id AND archived_at IS NULL
      AND CASE WHEN v_definition.source_kind='member' THEN source_record_id=p_member_id
        AND NOT(target_record_id=ANY(v_ids)) ELSE target_record_id=p_member_id
        AND NOT(source_record_id=ANY(v_ids)) END;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_archived:=v_archived+v_count;
  END LOOP;
  UPDATE public.member SET organization_id=p_organization_id
    WHERE tenant_id=p_tenant_id AND id=p_member_id AND organization_id IS DISTINCT FROM p_organization_id;
  FOR v_set IN SELECT value FROM jsonb_array_elements(p_sets) LOOP
    SELECT * INTO STRICT v_definition FROM public.custom_object_relationship_definition
      WHERE id=(v_set->>'definition_id')::uuid AND tenant_id=p_tenant_id;
    FOR v_related IN SELECT value::uuid FROM jsonb_array_elements_text(v_set->'related_ids') LOOP
      INSERT INTO public.custom_object_relationship(tenant_id,relationship_definition_id,source_record_id,target_record_id,created_by)
      SELECT p_tenant_id,v_definition.id,
        CASE WHEN v_definition.source_kind='member' THEN p_member_id ELSE v_related END,
        CASE WHEN v_definition.source_kind='member' THEN v_related ELSE p_member_id END,p_member_id::text
      WHERE NOT EXISTS (SELECT 1 FROM public.custom_object_relationship
        WHERE tenant_id=p_tenant_id AND relationship_definition_id=v_definition.id AND archived_at IS NULL
        AND source_record_id=CASE WHEN v_definition.source_kind='member' THEN p_member_id ELSE v_related END
        AND target_record_id=CASE WHEN v_definition.source_kind='member' THEN v_related ELSE p_member_id END);
      GET DIAGNOSTICS v_count=ROW_COUNT;
      v_added:=v_added+v_count;
    END LOOP;
  END LOOP;
  v_result:=jsonb_build_object('committed',true,'replayed',false,'added',v_added,'archived',v_archived,
    'snapshot',public.form_member_relationship_snapshot(p_tenant_id,p_member_id,v_definitions));
  INSERT INTO public.form_member_relationship_operation(tenant_id,submission_id,member_id,request,result)
    VALUES(p_tenant_id,p_submission_id,p_member_id,v_request,v_result);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.form_member_relationship_apply(uuid,uuid,uuid,jsonb,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_member_relationship_apply(uuid,uuid,uuid,jsonb,uuid,jsonb) TO service_role;
COMMIT;
