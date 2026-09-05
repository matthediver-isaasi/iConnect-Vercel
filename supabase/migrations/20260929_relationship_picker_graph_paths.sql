-- Relationship picker scopes can compare two bounded relationship paths.
-- The saved path stores immutable definition IDs and the side traversed at
-- each hop; labels and object names remain presentation-only.
CREATE OR REPLACE FUNCTION public.guard_custom_object_picker_scope_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_scope jsonb;
  v_source_length integer;
  v_target_length integer;
BEGIN
  IF NEW.archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT d.configuration->'picker_scope'
  INTO v_scope
  FROM public.custom_object_relationship_definition d
  WHERE d.id = NEW.relationship_definition_id
    AND d.tenant_id = NEW.tenant_id
    AND d.status = 'active';

  IF COALESCE((v_scope->>'version')::integer, 0) <> 2 THEN
    RETURN NEW;
  END IF;
  IF v_scope->>'match' <> 'intersects'
     OR jsonb_typeof(v_scope->'source_path') <> 'array'
     OR jsonb_typeof(v_scope->'target_path') <> 'array' THEN
    RAISE EXCEPTION 'Configured relationship picker scope is malformed'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_malformed';
  END IF;

  v_source_length := jsonb_array_length(v_scope->'source_path');
  v_target_length := jsonb_array_length(v_scope->'target_path');
  IF v_source_length NOT BETWEEN 1 AND 3 OR v_target_length NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Configured relationship picker scope path length is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_picker_scope_v2_path_length';
  END IF;

  IF NOT EXISTS (
    WITH RECURSIVE
    source_walk(step, record_id) AS (
      SELECT 0, NEW.source_record_id
      UNION ALL
      SELECT
        source_walk.step + 1,
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
         OR
         (hop.value->>'from_side' = 'target' AND edge.target_record_id = source_walk.record_id)
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
      SELECT
        target_walk.step + 1,
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
         OR
         (hop.value->>'from_side' = 'target' AND edge.target_record_id = target_walk.record_id)
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
    )
    SELECT 1
    FROM source_walk source_terminal
    JOIN target_walk target_terminal
      ON target_terminal.record_id = source_terminal.record_id
    WHERE source_terminal.step = v_source_length
      AND target_terminal.step = v_target_length
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

DROP TRIGGER IF EXISTS custom_object_picker_scope_v2_guard_trigger
  ON public.custom_object_relationship;
CREATE CONSTRAINT TRIGGER custom_object_picker_scope_v2_guard_trigger
AFTER INSERT OR UPDATE ON public.custom_object_relationship
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_picker_scope_v2();

REVOKE ALL ON FUNCTION public.guard_custom_object_picker_scope_v2()
  FROM PUBLIC, anon, authenticated;

-- Configure BNMS's first graph-scoped picker from exact, tenant-owned endpoint
-- shapes. Existing links are grandfathered; every new or restored link must
-- satisfy the secondary-organisation path.
DO $$
DECLARE
  v_tenant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid;
  v_department_object uuid;
  v_assignment_object uuid;
  v_direct_definition uuid;
  v_department_organisation uuid;
  v_assignment_member uuid;
  v_assignment_organisation uuid;
  v_count integer;
BEGIN
  -- This tenant configured the Assignment object through Data Studio rather
  -- than an earlier repository migration. Replays against databases where the
  -- tenant or that optional model is absent must remain safe and idempotent.
  -- Department is part of the repository-managed BNMS model; Assignment is
  -- optional Data Studio configuration. A replay may safely skip only while
  -- that optional object is wholly absent. Once it exists, all strict endpoint
  -- checks below must pass.
  IF NOT EXISTS (
    SELECT 1
    FROM public.custom_object_definition
    WHERE tenant_id = v_tenant
      AND object_key = 'member_organisation_assignment'
  ) THEN
    RAISE NOTICE 'Skipping BNMS relationship picker graph configuration because its Data Studio model is absent';
    RETURN;
  END IF;

  SELECT id INTO STRICT v_department_object
  FROM public.custom_object_definition
  WHERE tenant_id = v_tenant
    AND object_key = 'org_department'
    AND status = 'active';

  SELECT id INTO STRICT v_assignment_object
  FROM public.custom_object_definition
  WHERE tenant_id = v_tenant
    AND object_key = 'member_organisation_assignment'
    AND status = 'active';

  SELECT id INTO STRICT v_direct_definition
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant
    AND relationship_key = 'members'
    AND source_kind = 'custom_object'
    AND source_custom_object_id = v_department_object
    AND target_kind = 'member'
    AND target_custom_object_id IS NULL
    AND cardinality = 'many_to_many'
    AND status = 'active';

  SELECT id INTO STRICT v_department_organisation
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant
    AND relationship_key = 'organisation'
    AND source_kind = 'custom_object'
    AND source_custom_object_id = v_department_object
    AND target_kind = 'organization'
    AND target_custom_object_id IS NULL
    AND status = 'active';

  SELECT id INTO STRICT v_assignment_member
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant
    AND relationship_key = 'assignment_member'
    AND source_kind = 'custom_object'
    AND source_custom_object_id = v_assignment_object
    AND target_kind = 'member'
    AND target_custom_object_id IS NULL
    AND status = 'active';

  SELECT id INTO STRICT v_assignment_organisation
  FROM public.custom_object_relationship_definition
  WHERE tenant_id = v_tenant
    AND relationship_key = 'assignment_organisation_v2'
    AND source_kind = 'custom_object'
    AND source_custom_object_id = v_assignment_object
    AND target_kind = 'organization'
    AND target_custom_object_id IS NULL
    AND status = 'active';

  UPDATE public.custom_object_relationship_definition
  SET configuration = jsonb_set(
        COALESCE(configuration, '{}'::jsonb),
        '{picker_scope}',
        jsonb_build_object(
          'version', 2,
          'match', 'intersects',
          'source_path', jsonb_build_array(jsonb_build_object(
            'relationship_definition_id', v_department_organisation::text,
            'from_side', 'source'
          )),
          'target_path', jsonb_build_array(
            jsonb_build_object(
              'relationship_definition_id', v_assignment_member::text,
              'from_side', 'target'
            ),
            jsonb_build_object(
              'relationship_definition_id', v_assignment_organisation::text,
              'from_side', 'source'
            )
          )
        ),
        true
      ),
      updated_at = now()
  WHERE id = v_direct_definition
    AND tenant_id = v_tenant;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one BNMS Department-to-Member picker update; changed %', v_count;
  END IF;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Expected BNMS relationship picker graph endpoint was not found';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'BNMS relationship picker graph endpoint is ambiguous';
END;
$$;

-- The previous tenant-specific guards compared only member.organization_id.
-- They would reject valid secondary-organisation links and archive valid links
-- when a primary Organisation changes, so the versioned generic guard replaces
-- them for new/restored edges.
DROP TRIGGER IF EXISTS department_member_organization_consistency_trigger
  ON public.custom_object_relationship;
DROP TRIGGER IF EXISTS archive_invalid_bnms_member_departments_trigger
  ON public.member;
DROP FUNCTION IF EXISTS public.guard_department_member_organization_consistency();
DROP FUNCTION IF EXISTS public.archive_invalid_bnms_member_departments();