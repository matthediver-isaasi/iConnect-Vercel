-- Atomically creates an active Custom Object record with its initial edges.
-- Keeping this server-side means a failed required edge, eligibility check, or
-- cardinality guard rolls back the record as well as every preceding edge.
CREATE OR REPLACE FUNCTION public.create_custom_object_record_with_relationships(
  p_tenant_id uuid,
  p_custom_object_id uuid,
  p_data jsonb,
  p_relationships jsonb DEFAULT '[]'::jsonb,
  p_created_by text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_record public.custom_object_record%ROWTYPE;
  relationship public.custom_object_relationship%ROWTYPE;
  definition public.custom_object_relationship_definition%ROWTYPE;
  item jsonb;
  routed_side text;
  related_record_id uuid;
  source_id uuid;
  target_id uuid;
  supplied_required_definitions uuid[] := ARRAY[]::uuid[];
  created_relationships jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'Record data must be an object'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_record_data_object';
  END IF;
  IF jsonb_typeof(p_relationships) <> 'array' THEN
    RAISE EXCEPTION 'Initial relationships must be an array'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_initial_relationships_array';
  END IF;
  -- Serialize all creation requests for this object while the required-edge
  -- completeness check and row insert are in progress.
  PERFORM pg_advisory_xact_lock(hashtext(p_custom_object_id::text));
  IF NOT EXISTS (
    SELECT 1 FROM public.custom_object_definition object_definition
    WHERE object_definition.id = p_custom_object_id
      AND object_definition.tenant_id = p_tenant_id
      AND object_definition.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Custom Object record owner must belong to the same tenant and be active'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_record_same_tenant';
  END IF;

  INSERT INTO public.custom_object_record (
    tenant_id, custom_object_id, data, created_by, updated_by
  ) VALUES (
    p_tenant_id, p_custom_object_id, p_data, p_created_by, p_created_by
  ) RETURNING * INTO new_record;

  FOR item IN SELECT value FROM jsonb_array_elements(p_relationships)
  LOOP
    IF jsonb_typeof(item) <> 'object'
       OR COALESCE(item->>'relationship_definition_id', '') = ''
       OR COALESCE(item->>'related_record_id', '') = '' THEN
      RAISE EXCEPTION 'Each initial relationship requires relationship_definition_id and related_record_id'
        USING ERRCODE = '23514', CONSTRAINT = 'custom_object_initial_relationship_shape';
    END IF;
    BEGIN
      related_record_id := (item->>'related_record_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Initial relationship endpoint id is invalid'
        USING ERRCODE = '22P02';
    END;
    SELECT * INTO definition
    FROM public.custom_object_relationship_definition candidate
    WHERE candidate.id = (item->>'relationship_definition_id')::uuid
      AND candidate.tenant_id = p_tenant_id
    FOR SHARE;
    IF definition.id IS NULL OR definition.status <> 'active' THEN
      RAISE EXCEPTION 'Relationship definition is not active for this tenant'
        USING ERRCODE = '23503', CONSTRAINT = 'custom_object_relationship_definition_active';
    END IF;
    routed_side := item->>'routed_side';
    IF (COALESCE((item->>'originating')::boolean, false) AND routed_side = 'source' AND (
          definition.source_kind <> 'custom_object'
          OR definition.source_custom_object_id <> p_custom_object_id
          OR NOT definition.show_on_target OR NOT definition.edit_from_target))
       OR (COALESCE((item->>'originating')::boolean, false) AND routed_side = 'target' AND (
          definition.target_kind <> 'custom_object'
          OR definition.target_custom_object_id <> p_custom_object_id
          OR NOT definition.show_on_source OR NOT definition.edit_from_source))
       OR (NOT COALESCE((item->>'originating')::boolean, false) AND routed_side = 'source' AND (
          definition.source_kind <> 'custom_object'
          OR definition.source_custom_object_id <> p_custom_object_id
          OR NOT definition.show_on_source OR NOT definition.edit_from_source))
       OR (NOT COALESCE((item->>'originating')::boolean, false) AND routed_side = 'target' AND (
          definition.target_kind <> 'custom_object'
          OR definition.target_custom_object_id <> p_custom_object_id
          OR NOT definition.show_on_target OR NOT definition.edit_from_target))
       OR routed_side IS NULL OR routed_side NOT IN ('source', 'target') THEN
      RAISE EXCEPTION 'Relationship is not visible and editable from the new record side'
        USING ERRCODE = '23514', CONSTRAINT = 'custom_object_initial_relationship_routed_side';
    END IF;
    IF routed_side = 'source' THEN
      source_id := new_record.id;
      target_id := related_record_id;
    ELSE
      source_id := related_record_id;
      target_id := new_record.id;
    END IF;
    IF NOT public.custom_object_endpoint_exists(
      p_tenant_id, definition.source_kind, definition.source_custom_object_id, source_id
    ) OR NOT public.custom_object_endpoint_exists(
      p_tenant_id, definition.target_kind, definition.target_custom_object_id, target_id
    ) THEN
      RAISE EXCEPTION 'Initial relationship endpoint is unavailable or belongs to another tenant'
        USING ERRCODE = '23503', CONSTRAINT = 'custom_object_initial_relationship_endpoint_valid';
    END IF;
    INSERT INTO public.custom_object_relationship (
      tenant_id, relationship_definition_id, source_record_id, target_record_id, created_by
    ) VALUES (p_tenant_id, definition.id, source_id, target_id, p_created_by)
    RETURNING * INTO relationship;
    created_relationships := created_relationships || jsonb_build_array(to_jsonb(relationship));
    IF definition.is_required AND routed_side = 'source' THEN
      supplied_required_definitions := array_append(supplied_required_definitions, definition.id);
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.custom_object_relationship_definition required_definition
    WHERE required_definition.tenant_id = p_tenant_id
      AND required_definition.status = 'active'
      AND required_definition.is_required
      AND required_definition.source_kind = 'custom_object'
      AND required_definition.source_custom_object_id = p_custom_object_id
      AND NOT required_definition.id = ANY(supplied_required_definitions)
  ) THEN
    RAISE EXCEPTION 'A required relationship must be supplied when creating this record'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_required_relationship_create';
  END IF;
  RETURN jsonb_build_object('record', to_jsonb(new_record), 'relationships', created_relationships);
END;
$$;

REVOKE ALL ON FUNCTION public.create_custom_object_record_with_relationships(uuid, uuid, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_custom_object_record_with_relationships(uuid, uuid, jsonb, jsonb, text)
  TO service_role;