-- Allow a graph-scoped relationship side to contribute a validated core field
-- to its terminal set. The first supported source is Member.organization_id,
-- which terminates at the core Organization endpoint.
CREATE OR REPLACE FUNCTION public.guard_custom_object_picker_scope_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_scope jsonb;
  v_direct_definition public.custom_object_relationship_definition%ROWTYPE;
  v_path_definition public.custom_object_relationship_definition%ROWTYPE;
  v_path_side text;
  v_hop jsonb;
  v_hop_side text;
  v_current_kind text;
  v_current_object uuid;
  v_terminal_source_kind text;
  v_terminal_source_object uuid;
  v_terminal_target_kind text;
  v_terminal_target_object uuid;
  v_seen_definitions uuid[];
  v_seen_endpoints text[];
  v_endpoint_key text;
  v_index integer;
  v_source_length integer;
  v_target_length integer;
  v_source_primary_organisation uuid;
  v_target_primary_organisation uuid;
BEGIN
  IF NEW.archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT d.*
  INTO v_direct_definition
  FROM public.custom_object_relationship_definition d
  WHERE d.id = NEW.relationship_definition_id
    AND d.tenant_id = NEW.tenant_id
    AND d.status = 'active';
  v_scope := v_direct_definition.configuration->'picker_scope';

  IF COALESCE((v_scope->>'version')::integer, 0) <> 2 THEN
    RETURN NEW;
  END IF;
  IF v_scope->>'match' <> 'intersects'
     OR jsonb_typeof(v_scope->'source_path') <> 'array'
     OR jsonb_typeof(v_scope->'target_path') <> 'array'
     OR (
       v_scope ? 'target_terminal_sources'
       AND v_scope->'target_terminal_sources'
         <> '[{"type":"core_field","field":"organization_id"}]'::jsonb
     )
     OR (
       v_scope ? 'source_terminal_sources'
       AND v_scope->'source_terminal_sources'
         <> '[{"type":"core_field","field":"organization_id"}]'::jsonb
     ) THEN
    RAISE EXCEPTION 'Configured relationship picker scope is malformed'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_malformed';
  END IF;

  v_source_length := jsonb_array_length(v_scope->'source_path');
  v_target_length := jsonb_array_length(v_scope->'target_path');
  IF v_source_length NOT BETWEEN 1 AND 3 OR v_target_length NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Configured relationship picker scope path length is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_path_length';
  END IF;

  -- Validate both saved paths independently of the API. This keeps the
  -- database guard authoritative when definitions are changed through SQL.
  FOREACH v_path_side IN ARRAY ARRAY['source', 'target'] LOOP
    IF v_path_side = 'source' THEN
      v_current_kind := v_direct_definition.source_kind;
      v_current_object := v_direct_definition.source_custom_object_id;
    ELSE
      v_current_kind := v_direct_definition.target_kind;
      v_current_object := v_direct_definition.target_custom_object_id;
    END IF;
    v_seen_definitions := ARRAY[v_direct_definition.id];
    v_seen_endpoints := ARRAY[
      v_current_kind || ':' || COALESCE(v_current_object::text, '')
    ];

    FOR v_index IN 0..jsonb_array_length(v_scope->(v_path_side || '_path')) - 1 LOOP
      v_hop := (v_scope->(v_path_side || '_path'))->v_index;
      v_hop_side := v_hop->>'from_side';
      IF v_hop_side NOT IN ('source', 'target') THEN
        RAISE EXCEPTION 'Configured relationship picker scope is malformed'
          USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_malformed';
      END IF;

      SELECT d.* INTO v_path_definition
      FROM public.custom_object_relationship_definition d
      WHERE d.id = (v_hop->>'relationship_definition_id')::uuid
        AND d.tenant_id = NEW.tenant_id
        AND d.status = 'active';
      IF NOT FOUND
         OR v_path_definition.id = ANY(v_seen_definitions)
         OR v_path_definition.tenant_id <> NEW.tenant_id
         OR (
           v_hop_side = 'source'
           AND (
             v_path_definition.source_kind <> v_current_kind
             OR v_path_definition.source_custom_object_id IS DISTINCT FROM v_current_object
           )
         )
         OR (
           v_hop_side = 'target'
           AND (
             v_path_definition.target_kind <> v_current_kind
             OR v_path_definition.target_custom_object_id IS DISTINCT FROM v_current_object
           )
         ) THEN
        RAISE EXCEPTION 'Configured relationship picker scope path is unavailable or disconnected'
          USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_path_unavailable';
      END IF;

      v_seen_definitions := array_append(v_seen_definitions, v_path_definition.id);
      IF v_hop_side = 'source' THEN
        v_current_kind := v_path_definition.target_kind;
        v_current_object := v_path_definition.target_custom_object_id;
      ELSE
        v_current_kind := v_path_definition.source_kind;
        v_current_object := v_path_definition.source_custom_object_id;
      END IF;
      v_endpoint_key := v_current_kind || ':' || COALESCE(v_current_object::text, '');
      IF v_endpoint_key = ANY(v_seen_endpoints) THEN
        RAISE EXCEPTION 'Configured relationship picker scope path is cyclic'
          USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_path_cyclic';
      END IF;
      v_seen_endpoints := array_append(v_seen_endpoints, v_endpoint_key);
    END LOOP;

    IF v_path_side = 'source' THEN
      v_terminal_source_kind := v_current_kind;
      v_terminal_source_object := v_current_object;
    ELSE
      v_terminal_target_kind := v_current_kind;
      v_terminal_target_object := v_current_object;
    END IF;
  END LOOP;

  IF v_terminal_source_kind <> v_terminal_target_kind
     OR v_terminal_source_object IS DISTINCT FROM v_terminal_target_object THEN
    RAISE EXCEPTION 'Configured relationship picker scope paths end at different record types'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_terminal_mismatch';
  END IF;

  IF v_scope ? 'source_terminal_sources' THEN
    IF v_direct_definition.source_kind <> 'member'
       OR v_direct_definition.source_custom_object_id IS NOT NULL
       OR v_terminal_source_kind <> 'organization'
       OR v_terminal_source_object IS NOT NULL THEN
      RAISE EXCEPTION 'Configured relationship picker scope terminal source is unavailable'
        USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_terminal_source';
    END IF;
    SELECT m.organization_id
    INTO v_source_primary_organisation
    FROM public.member m
    WHERE m.id = NEW.source_record_id
      AND m.tenant_id = NEW.tenant_id;
  END IF;

  IF v_scope ? 'target_terminal_sources' THEN
    IF v_direct_definition.target_kind <> 'member'
       OR v_direct_definition.target_custom_object_id IS NOT NULL
       OR v_terminal_target_kind <> 'organization'
       OR v_terminal_target_object IS NOT NULL THEN
      RAISE EXCEPTION 'Configured relationship picker scope terminal source is unavailable'
        USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_terminal_source';
    END IF;
    SELECT m.organization_id
    INTO v_target_primary_organisation
    FROM public.member m
    WHERE m.id = NEW.target_record_id
      AND m.tenant_id = NEW.tenant_id;
  END IF;

  IF NOT EXISTS (
    WITH RECURSIVE
    source_walk(step, record_id) AS (
      SELECT 0, NEW.source_record_id
      UNION ALL
      SELECT source_walk.step + 1,
        CASE hop.value->>'from_side'
          WHEN 'source' THEN edge.target_record_id
          WHEN 'target' THEN edge.source_record_id
        END
      FROM source_walk
      JOIN LATERAL (
        SELECT v_scope->'source_path'->source_walk.step AS value
      ) hop ON source_walk.step < v_source_length
      JOIN public.custom_object_relationship_definition path_definition
        ON path_definition.id = (hop.value->>'relationship_definition_id')::uuid
       AND path_definition.tenant_id = NEW.tenant_id
       AND path_definition.status = 'active'
      JOIN public.custom_object_relationship edge
        ON edge.tenant_id = NEW.tenant_id
       AND edge.relationship_definition_id = path_definition.id
       AND edge.archived_at IS NULL
       AND (
         (hop.value->>'from_side' = 'source' AND edge.source_record_id = source_walk.record_id)
         OR (hop.value->>'from_side' = 'target' AND edge.target_record_id = source_walk.record_id)
       )
      WHERE public.custom_object_endpoint_exists(
        NEW.tenant_id,
        CASE hop.value->>'from_side'
          WHEN 'source' THEN path_definition.target_kind
          WHEN 'target' THEN path_definition.source_kind
        END,
        CASE hop.value->>'from_side'
          WHEN 'source' THEN path_definition.target_custom_object_id
          WHEN 'target' THEN path_definition.source_custom_object_id
        END,
        CASE hop.value->>'from_side'
          WHEN 'source' THEN edge.target_record_id
          WHEN 'target' THEN edge.source_record_id
        END
      )
    ),
    target_walk(step, record_id) AS (
      SELECT 0, NEW.target_record_id
      UNION ALL
      SELECT target_walk.step + 1,
        CASE hop.value->>'from_side'
          WHEN 'source' THEN edge.target_record_id
          WHEN 'target' THEN edge.source_record_id
        END
      FROM target_walk
      JOIN LATERAL (
        SELECT v_scope->'target_path'->target_walk.step AS value
      ) hop ON target_walk.step < v_target_length
      JOIN public.custom_object_relationship_definition path_definition
        ON path_definition.id = (hop.value->>'relationship_definition_id')::uuid
       AND path_definition.tenant_id = NEW.tenant_id
       AND path_definition.status = 'active'
      JOIN public.custom_object_relationship edge
        ON edge.tenant_id = NEW.tenant_id
       AND edge.relationship_definition_id = path_definition.id
       AND edge.archived_at IS NULL
       AND (
         (hop.value->>'from_side' = 'source' AND edge.source_record_id = target_walk.record_id)
         OR (hop.value->>'from_side' = 'target' AND edge.target_record_id = target_walk.record_id)
       )
      WHERE public.custom_object_endpoint_exists(
        NEW.tenant_id,
        CASE hop.value->>'from_side'
          WHEN 'source' THEN path_definition.target_kind
          WHEN 'target' THEN path_definition.source_kind
        END,
        CASE hop.value->>'from_side'
          WHEN 'source' THEN path_definition.target_custom_object_id
          WHEN 'target' THEN path_definition.source_custom_object_id
        END,
        CASE hop.value->>'from_side'
          WHEN 'source' THEN edge.target_record_id
          WHEN 'target' THEN edge.source_record_id
        END
      )
    ),
    source_terminals(record_id) AS (
      SELECT source_walk.record_id
      FROM source_walk
      WHERE source_walk.step = v_source_length
      UNION
      SELECT v_source_primary_organisation
      WHERE v_source_primary_organisation IS NOT NULL
    ),
    target_terminals(record_id) AS (
      SELECT target_walk.record_id
      FROM target_walk
      WHERE target_walk.step = v_target_length
      UNION
      SELECT v_target_primary_organisation
      WHERE v_target_primary_organisation IS NOT NULL
    )
    SELECT 1
    FROM source_terminals source_terminal
    JOIN target_terminals target_terminal
      ON target_terminal.record_id = source_terminal.record_id
  ) THEN
    RAISE EXCEPTION 'Related record is outside the configured picker scope'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_no_intersection';
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Configured relationship picker scope contains an invalid definition ID'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_definition_id';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_custom_object_picker_scope_v2()
  FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_tenant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid;
  v_department_object uuid;
  v_count integer;
BEGIN
  SELECT id INTO v_department_object
  FROM public.custom_object_definition
  WHERE tenant_id = v_tenant
    AND object_key = 'org_department'
    AND status = 'active';
  IF v_department_object IS NULL THEN
    RAISE NOTICE 'Skipping BNMS Department picker terminal source because the active object is absent';
    RETURN;
  END IF;

  UPDATE public.custom_object_relationship_definition
  SET configuration = jsonb_set(
        COALESCE(configuration, '{}'::jsonb),
        '{picker_scope,target_terminal_sources}',
        '[{"type":"core_field","field":"organization_id"}]'::jsonb,
        true
      ),
      updated_at = now()
  WHERE tenant_id = v_tenant
    AND relationship_key = 'members'
    AND source_kind = 'custom_object'
    AND source_custom_object_id = v_department_object
    AND target_kind = 'member'
    AND target_custom_object_id IS NULL
    AND status = 'active'
    AND configuration->'picker_scope'->>'version' = '2';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one BNMS Department-to-Member picker update; changed %', v_count;
  END IF;
END;
$$;