-- Bounded catalogue aggregates, stable pagination indexes, and audit hardening.

CREATE OR REPLACE FUNCTION public.custom_object_catalogue_counts(
  p_tenant_id uuid,
  p_custom_object_ids uuid[]
)
RETURNS TABLE (
  custom_object_id uuid,
  record_count bigint,
  field_count bigint,
  relationship_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested AS (
    SELECT DISTINCT requested_id AS custom_object_id
    FROM unnest(COALESCE(p_custom_object_ids, ARRAY[]::uuid[]))
      AS requested_ids(requested_id)
    JOIN public.custom_object_definition definition
      ON definition.id = requested_id
     AND definition.tenant_id = p_tenant_id
  ),
  records AS (
    SELECT record.custom_object_id, count(*) AS record_count
    FROM public.custom_object_record record
    JOIN requested USING (custom_object_id)
    WHERE record.tenant_id = p_tenant_id
      AND record.archived_at IS NULL
    GROUP BY record.custom_object_id
  ),
  fields AS (
    SELECT field.custom_object_id, count(*) AS field_count
    FROM public.preference_field field
    JOIN requested USING (custom_object_id)
    WHERE field.tenant_id = p_tenant_id
      AND field.entity_scope = 'custom_object'
      AND field.is_active = true
    GROUP BY field.custom_object_id
  ),
  relationships AS (
    SELECT endpoint.custom_object_id, count(DISTINCT endpoint.relationship_id) AS relationship_count
    FROM (
      SELECT definition.id AS relationship_id, definition.source_custom_object_id AS custom_object_id
      FROM public.custom_object_relationship_definition definition
      JOIN requested ON requested.custom_object_id = definition.source_custom_object_id
      WHERE definition.tenant_id = p_tenant_id
        AND definition.status <> 'archived'
      UNION ALL
      SELECT definition.id, definition.target_custom_object_id
      FROM public.custom_object_relationship_definition definition
      JOIN requested ON requested.custom_object_id = definition.target_custom_object_id
      WHERE definition.tenant_id = p_tenant_id
        AND definition.status <> 'archived'
    ) endpoint
    GROUP BY endpoint.custom_object_id
  )
  SELECT requested.custom_object_id,
         COALESCE(records.record_count, 0),
         COALESCE(fields.field_count, 0),
         COALESCE(relationships.relationship_count, 0)
  FROM requested
  LEFT JOIN records USING (custom_object_id)
  LEFT JOIN fields USING (custom_object_id)
  LEFT JOIN relationships USING (custom_object_id);
$$;

REVOKE ALL ON FUNCTION public.custom_object_catalogue_counts(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_catalogue_counts(uuid, uuid[])
  TO service_role;

CREATE INDEX IF NOT EXISTS idx_custom_object_record_active_created_stable
  ON public.custom_object_record (tenant_id, custom_object_id, created_at, id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_object_record_active_updated_stable
  ON public.custom_object_record (tenant_id, custom_object_id, updated_at, id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_custom_object_relationship_source_created
  ON public.custom_object_relationship (
    tenant_id, relationship_definition_id, source_record_id, created_at DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS idx_custom_object_relationship_target_created
  ON public.custom_object_relationship (
    tenant_id, relationship_definition_id, target_record_id, created_at DESC, id DESC
  );

ALTER TABLE public.custom_object_audit_event
  DROP CONSTRAINT IF EXISTS custom_object_audit_event_entity_type;
ALTER TABLE public.custom_object_audit_event
  ADD CONSTRAINT custom_object_audit_event_entity_type
  CHECK (entity_type IN (
    'custom_object_definition',
    'preference_field',
    'custom_object_record',
    'custom_object_relationship_definition',
    'custom_object_relationship',
    'custom_object_role_permission'
  ));