-- One transaction and one object-scoped lock make the pinned Workforce Survey
-- import safe against interruption, retries, and concurrent apply processes.
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
  survey_record public.custom_object_record%ROWTYPE;
  row_record public.custom_object_record%ROWTYPE;
  item jsonb;
  result jsonb;
  survey_count integer;
  row_count integer;
  edge_count integer;
  edge_target uuid;
  rows_created integer := 0;
  rows_reused integer := 0;
  survey_created integer := 0;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) <> 8 THEN
    RAISE EXCEPTION 'Pinned Workforce Survey import requires exactly eight rows';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_survey_object_id::text));

  SELECT count(*), (array_agg(record.id))[1] INTO survey_count, survey_record.id
  FROM public.custom_object_record record
  WHERE record.tenant_id = p_tenant_id
    AND record.custom_object_id = p_survey_object_id
    AND record.archived_at IS NULL
    AND record.data->>'survey_name' = p_reporting_year;
  IF survey_count > 1 THEN
    RAISE EXCEPTION 'Reporting year has duplicate active survey records';
  ELSIF survey_count = 0 THEN
    SELECT public.create_custom_object_record_with_relationships(
      p_tenant_id, p_survey_object_id,
      jsonb_build_object('survey_name', p_reporting_year), '[]'::jsonb, p_actor
    ) INTO result;
    survey_record.id := (result->'record'->>'id')::uuid;
    survey_created := 1;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF jsonb_typeof(item->'data') <> 'object'
       OR COALESCE(item->>'department_id', '') = '' THEN
      RAISE EXCEPTION 'Each Workforce Survey row requires data and department_id';
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
          FROM public.custom_object_relationship department_edge
          WHERE department_edge.tenant_id = p_tenant_id
            AND department_edge.relationship_definition_id = p_department_relationship_id
            AND department_edge.source_record_id = candidate.id
            AND department_edge.archived_at IS NULL
        ) <> 1
    ) THEN
      RAISE EXCEPTION 'Data-identical Workforce Survey row has a missing or duplicate Department edge';
    END IF;
    SELECT count(*), (array_agg(record.id))[1] INTO row_count, row_record.id
    FROM public.custom_object_record record
    JOIN public.custom_object_relationship department_edge
      ON department_edge.relationship_definition_id = p_department_relationship_id
     AND department_edge.source_record_id = record.id
     AND department_edge.target_record_id = (item->>'department_id')::uuid
     AND department_edge.archived_at IS NULL
    WHERE record.tenant_id = p_tenant_id
      AND record.custom_object_id = p_row_object_id
      AND record.archived_at IS NULL
      AND record.data = item->'data';
    IF row_count > 1 THEN
      RAISE EXCEPTION 'Workforce Survey row natural key is ambiguous';
    ELSIF row_count = 0 THEN
      SELECT public.create_custom_object_record_with_relationships(
        p_tenant_id, p_row_object_id, item->'data',
        jsonb_build_array(
          jsonb_build_object(
            'relationship_definition_id', p_survey_relationship_id,
            'routed_side', 'source', 'related_record_id', survey_record.id
          ),
          jsonb_build_object(
            'relationship_definition_id', p_department_relationship_id,
            'routed_side', 'source', 'related_record_id', item->>'department_id'
          )
        ),
        p_actor
      ) INTO result;
      rows_created := rows_created + 1;
    ELSE
      SELECT count(*), (array_agg(edge.target_record_id))[1]
      INTO edge_count, edge_target
      FROM public.custom_object_relationship edge
      WHERE edge.tenant_id = p_tenant_id
        AND edge.relationship_definition_id = p_survey_relationship_id
        AND edge.source_record_id = row_record.id
        AND edge.archived_at IS NULL;
      IF edge_count > 1 OR (edge_count = 1 AND edge_target <> survey_record.id) THEN
        RAISE EXCEPTION 'Existing Workforce Survey row belongs to a different or duplicate survey';
      ELSIF edge_count = 0 THEN
        INSERT INTO public.custom_object_relationship (
          tenant_id, relationship_definition_id, source_record_id,
          target_record_id, created_by
        ) VALUES (
          p_tenant_id, p_survey_relationship_id, row_record.id,
          survey_record.id, p_actor
        );
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.custom_object_relationship edge
        WHERE edge.tenant_id = p_tenant_id
          AND edge.relationship_definition_id = p_survey_relationship_id
          AND edge.source_record_id = row_record.id
          AND edge.target_record_id = survey_record.id
          AND edge.archived_at IS NULL
      ) THEN
        RAISE EXCEPTION 'Existing Workforce Survey row reconciliation failed';
      END IF;
      rows_reused := rows_reused + 1;
    END IF;
  END LOOP;

  SELECT count(*) INTO row_count
  FROM public.custom_object_relationship edge
  JOIN public.custom_object_record record
    ON record.id = edge.source_record_id
   AND record.tenant_id = p_tenant_id
   AND record.custom_object_id = p_row_object_id
   AND record.archived_at IS NULL
  WHERE edge.tenant_id = p_tenant_id
    AND edge.relationship_definition_id = p_survey_relationship_id
    AND edge.target_record_id = survey_record.id
    AND edge.archived_at IS NULL;
  IF row_count <> 8 THEN
    RAISE EXCEPTION 'Survey must have exactly eight active rows; found %', row_count;
  END IF;
  RETURN jsonb_build_object(
    'surveysCreated', survey_created,
    'surveysReused', 1 - survey_created,
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