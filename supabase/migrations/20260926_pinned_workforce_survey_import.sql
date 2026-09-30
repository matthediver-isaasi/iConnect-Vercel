-- One transaction and one object-scoped lock make the pinned, Department-grouped
-- Workforce Survey import safe against interruption, retries, and concurrency.
DO $$
DECLARE
  changed integer;
  grade_options jsonb;
BEGIN
  UPDATE public.preference_field
  SET is_required = false
  WHERE tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
    AND custom_object_id = 'bf123bdb-7227-4f45-b5f9-8344d0f65446'::uuid
    AND entity_scope = 'custom_object'
    AND name = 'vacant_wte'
    AND is_active = true
    AND field_type = 'decimal'
    AND label = 'Vacant WTE';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'Pinned Vacant WTE field did not resolve exactly once';
  END IF;

  SELECT count(*), (array_agg(options))[1] INTO changed, grade_options
  FROM public.preference_field
  WHERE tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
    AND custom_object_id = 'bf123bdb-7227-4f45-b5f9-8344d0f65446'::uuid
    AND entity_scope = 'custom_object'
    AND name = 'grade'
    AND is_active = true
    AND field_type = 'dropdown'
    AND label = 'Grade';
  IF changed <> 1 OR grade_options IS NULL OR jsonb_typeof(grade_options) <> 'array' THEN
    RAISE EXCEPTION 'Pinned Grade field did not resolve to one dropdown option array';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(grade_options) option
    WHERE option->>'label' = 'Radionuclide Radiologist'
       OR option->>'value' = 'Radionuclide Radiologist'
  ) AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(grade_options) option
    WHERE option->>'label' = 'Radionuclide Radiologist'
      AND option->>'value' = 'Radionuclide Radiologist'
  ) THEN
    RAISE EXCEPTION 'Pinned Grade option conflicts with Radionuclide Radiologist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(grade_options) option
    WHERE option->>'label' = 'Radionuclide Radiologist'
      AND option->>'value' = 'Radionuclide Radiologist'
  ) THEN
    UPDATE public.preference_field
    SET options = grade_options || jsonb_build_array(jsonb_build_object(
      'label', 'Radionuclide Radiologist',
      'value', 'Radionuclide Radiologist'
    ))
    WHERE tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
      AND custom_object_id = 'bf123bdb-7227-4f45-b5f9-8344d0f65446'::uuid
      AND entity_scope = 'custom_object'
      AND name = 'grade'
      AND is_active = true;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.import_pinned_workforce_survey(
  p_tenant_id uuid,
  p_survey_object_id uuid,
  p_row_object_id uuid,
  p_survey_relationship_id uuid,
  p_department_relationship_id uuid,
  p_reporting_year text,
  p_rows jsonb,
  p_actor text DEFAULT 'system:workforce-survey-import'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  department_id uuid;
  survey_id uuid;
  row_id uuid;
  item jsonb;
  result jsonb;
  match_count integer;
  edge_count integer;
  edge_target uuid;
  rows_created integer := 0;
  rows_reused integer := 0;
  surveys_created integer := 0;
  surveys_reused integer := 0;
  department_count integer;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) <> 8 THEN
    RAISE EXCEPTION 'Pinned Workforce Survey import requires exactly eight rows';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_survey_object_id::text));

  SELECT count(DISTINCT value->>'department_id')
  INTO department_count
  FROM jsonb_array_elements(p_rows);
  IF department_count <> 3 THEN
    RAISE EXCEPTION 'Pinned Workforce Survey import requires exactly three Departments';
  END IF;

  FOR department_id IN
    SELECT DISTINCT (value->>'department_id')::uuid
    FROM jsonb_array_elements(p_rows)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.custom_object_record department
      JOIN public.custom_object_relationship_definition definition
        ON definition.id = p_department_relationship_id
       AND definition.tenant_id = p_tenant_id
       AND definition.status = 'active'
       AND definition.source_custom_object_id = p_survey_object_id
       AND definition.target_custom_object_id = department.custom_object_id
      WHERE department.id = department_id
        AND department.tenant_id = p_tenant_id
        AND department.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Department % cannot be resolved for this tenant and relationship', department_id;
    END IF;

    SELECT count(*), (array_agg(survey.id))[1]
    INTO match_count, survey_id
    FROM public.custom_object_record survey
    JOIN public.custom_object_relationship department_edge
      ON department_edge.tenant_id = p_tenant_id
     AND department_edge.relationship_definition_id = p_department_relationship_id
     AND department_edge.source_record_id = survey.id
     AND department_edge.target_record_id = department_id
     AND department_edge.archived_at IS NULL
    WHERE survey.tenant_id = p_tenant_id
      AND survey.custom_object_id = p_survey_object_id
      AND survey.archived_at IS NULL
      AND survey.data->>'survey_name' = p_reporting_year;
    IF match_count > 1 THEN
      RAISE EXCEPTION 'Reporting year and Department have duplicate active survey records';
    ELSIF match_count = 0 THEN
      SELECT public.create_custom_object_record_with_relationships(
        p_tenant_id,
        p_survey_object_id,
        jsonb_build_object('survey_name', p_reporting_year),
        jsonb_build_array(jsonb_build_object(
          'relationship_definition_id', p_department_relationship_id,
          'routed_side', 'source',
          'related_record_id', department_id
        )),
        p_actor
      ) INTO result;
      survey_id := (result->'record'->>'id')::uuid;
      surveys_created := surveys_created + 1;
    ELSE
      SELECT count(*) INTO edge_count
      FROM public.custom_object_relationship edge
      WHERE edge.tenant_id = p_tenant_id
        AND edge.relationship_definition_id = p_department_relationship_id
        AND edge.source_record_id = survey_id
        AND edge.archived_at IS NULL;
      IF edge_count <> 1 THEN
        RAISE EXCEPTION 'Existing Workforce Survey must have exactly one Department edge';
      END IF;
      surveys_reused := surveys_reused + 1;
    END IF;

    FOR item IN
      SELECT value FROM jsonb_array_elements(p_rows)
      WHERE (value->>'department_id')::uuid = department_id
    LOOP
      IF jsonb_typeof(item->'data') <> 'object' THEN
        RAISE EXCEPTION 'Each Workforce Survey row requires data';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM public.custom_object_record candidate
        WHERE candidate.tenant_id = p_tenant_id
          AND candidate.custom_object_id = p_row_object_id
          AND candidate.archived_at IS NULL
          AND candidate.data = item->'data'
          AND (
            SELECT count(*)
            FROM public.custom_object_relationship survey_edge
            WHERE survey_edge.tenant_id = p_tenant_id
              AND survey_edge.relationship_definition_id = p_survey_relationship_id
              AND survey_edge.source_record_id = candidate.id
              AND survey_edge.archived_at IS NULL
          ) <> 1
      ) THEN
        RAISE EXCEPTION 'Data-identical Workforce Survey row has a missing or duplicate Survey edge';
      END IF;

      SELECT count(*), (array_agg(candidate.id))[1]
      INTO match_count, row_id
      FROM public.custom_object_record candidate
      JOIN public.custom_object_relationship survey_edge
        ON survey_edge.tenant_id = p_tenant_id
       AND survey_edge.relationship_definition_id = p_survey_relationship_id
       AND survey_edge.source_record_id = candidate.id
       AND survey_edge.target_record_id = survey_id
       AND survey_edge.archived_at IS NULL
      WHERE candidate.tenant_id = p_tenant_id
        AND candidate.custom_object_id = p_row_object_id
        AND candidate.archived_at IS NULL
        AND candidate.data = item->'data';
      IF match_count > 1 THEN
        RAISE EXCEPTION 'Workforce Survey row natural key is ambiguous';
      ELSIF match_count = 0 THEN
        SELECT public.create_custom_object_record_with_relationships(
          p_tenant_id,
          p_row_object_id,
          item->'data',
          jsonb_build_array(jsonb_build_object(
            'relationship_definition_id', p_survey_relationship_id,
            'routed_side', 'source',
            'related_record_id', survey_id
          )),
          p_actor
        ) INTO result;
        rows_created := rows_created + 1;
      ELSE
        SELECT count(*), (array_agg(edge.target_record_id))[1]
        INTO edge_count, edge_target
        FROM public.custom_object_relationship edge
        WHERE edge.tenant_id = p_tenant_id
          AND edge.relationship_definition_id = p_survey_relationship_id
          AND edge.source_record_id = row_id
          AND edge.archived_at IS NULL;
        IF edge_count <> 1 OR edge_target <> survey_id THEN
          RAISE EXCEPTION 'Existing Workforce Survey row belongs to a different or duplicate survey';
        END IF;
        rows_reused := rows_reused + 1;
      END IF;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO match_count
  FROM jsonb_array_elements(p_rows) expected
  JOIN public.custom_object_relationship department_edge
    ON department_edge.tenant_id = p_tenant_id
   AND department_edge.relationship_definition_id = p_department_relationship_id
   AND department_edge.target_record_id = (expected.value->>'department_id')::uuid
   AND department_edge.archived_at IS NULL
  JOIN public.custom_object_record survey
    ON survey.id = department_edge.source_record_id
   AND survey.tenant_id = p_tenant_id
   AND survey.custom_object_id = p_survey_object_id
   AND survey.archived_at IS NULL
   AND survey.data->>'survey_name' = p_reporting_year
  JOIN public.custom_object_relationship survey_edge
    ON survey_edge.tenant_id = p_tenant_id
   AND survey_edge.relationship_definition_id = p_survey_relationship_id
   AND survey_edge.target_record_id = survey.id
   AND survey_edge.archived_at IS NULL
  JOIN public.custom_object_record row_record
    ON row_record.id = survey_edge.source_record_id
   AND row_record.tenant_id = p_tenant_id
   AND row_record.custom_object_id = p_row_object_id
   AND row_record.archived_at IS NULL
   AND row_record.data = expected.value->'data';
  IF match_count <> 8 THEN
    RAISE EXCEPTION 'Department-grouped surveys must contain exactly the eight supplied rows; found %', match_count;
  END IF;

  SELECT count(*) INTO match_count
  FROM public.custom_object_record survey
  WHERE survey.tenant_id = p_tenant_id
    AND survey.custom_object_id = p_survey_object_id
    AND survey.archived_at IS NULL
    AND survey.data->>'survey_name' = p_reporting_year;
  IF match_count <> 3 THEN
    RAISE EXCEPTION 'Reporting year must have exactly three active Department surveys; found %', match_count;
  END IF;

  SELECT count(*) INTO match_count
  FROM public.custom_object_relationship survey_edge
  JOIN public.custom_object_record survey
    ON survey.id = survey_edge.target_record_id
   AND survey.tenant_id = p_tenant_id
   AND survey.custom_object_id = p_survey_object_id
   AND survey.archived_at IS NULL
   AND survey.data->>'survey_name' = p_reporting_year
  JOIN public.custom_object_relationship department_edge
    ON department_edge.tenant_id = p_tenant_id
   AND department_edge.relationship_definition_id = p_department_relationship_id
   AND department_edge.source_record_id = survey.id
   AND department_edge.archived_at IS NULL
   AND department_edge.target_record_id IN (
     SELECT DISTINCT (value->>'department_id')::uuid
     FROM jsonb_array_elements(p_rows)
   )
  WHERE survey_edge.tenant_id = p_tenant_id
    AND survey_edge.relationship_definition_id = p_survey_relationship_id
    AND survey_edge.archived_at IS NULL;
  IF match_count <> 8 THEN
    RAISE EXCEPTION 'Department surveys must have exactly eight total active rows; found %', match_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.custom_object_relationship direct_edge
    JOIN public.custom_object_relationship_definition direct_definition
      ON direct_definition.id = direct_edge.relationship_definition_id
     AND direct_definition.tenant_id = p_tenant_id
     AND direct_definition.status = 'active'
     AND direct_definition.source_custom_object_id = p_row_object_id
     AND direct_definition.target_custom_object_id = (
       SELECT target_custom_object_id
       FROM public.custom_object_relationship_definition
       WHERE id = p_department_relationship_id
         AND tenant_id = p_tenant_id
     )
    JOIN public.custom_object_relationship survey_edge
      ON survey_edge.tenant_id = p_tenant_id
     AND survey_edge.relationship_definition_id = p_survey_relationship_id
     AND survey_edge.source_record_id = direct_edge.source_record_id
     AND survey_edge.archived_at IS NULL
    JOIN public.custom_object_record survey
      ON survey.id = survey_edge.target_record_id
     AND survey.tenant_id = p_tenant_id
     AND survey.custom_object_id = p_survey_object_id
     AND survey.archived_at IS NULL
     AND survey.data->>'survey_name' = p_reporting_year
    WHERE direct_edge.tenant_id = p_tenant_id
      AND direct_edge.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Workforce Survey Rows must not have direct Department relationships';
  END IF;

  RETURN jsonb_build_object(
    'surveysCreated', surveys_created,
    'surveysReused', surveys_reused,
    'rowsCreated', rows_created,
    'rowsReused', rows_reused,
    'rejected', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_pinned_workforce_survey(
  uuid, uuid, uuid, uuid, uuid, text, jsonb, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_pinned_workforce_survey(
  uuid, uuid, uuid, uuid, uuid, text, jsonb, text
) TO service_role;
NOTIFY pgrst, 'reload schema';