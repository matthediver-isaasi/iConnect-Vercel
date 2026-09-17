-- BNMS Department current-set editing.  This is intentionally a narrow,
-- service-only integration: it does not alter generic Data Studio grants and
-- it does not run an import or change catalogue data.

CREATE TABLE IF NOT EXISTS public.department_current_set_config (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES public.form(id) ON DELETE CASCADE,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, form_id),
  CONSTRAINT department_current_set_config_object CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT department_current_set_config_scope CHECK (
    tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
    AND form_id = '8b6f44d3-83f8-449e-9496-b10b1dc28e5f'::uuid
  )
);

CREATE TABLE IF NOT EXISTS public.department_current_set_commit (
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  department_id uuid NOT NULL,
  submission_id uuid NOT NULL REFERENCES public.form_submission(id) ON DELETE RESTRICT,
  answer_digest text NOT NULL,
  response jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, form_id, submission_id),
  CONSTRAINT department_current_set_commit_response CHECK (jsonb_typeof(response) = 'object')
);

CREATE INDEX IF NOT EXISTS department_current_set_commit_department_idx
  ON public.department_current_set_commit (tenant_id, form_id, department_id, committed_at DESC);

ALTER TABLE public.department_current_set_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_current_set_commit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.department_current_set_config, public.department_current_set_commit
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.department_current_set_config, public.department_current_set_commit
  TO service_role;

-- No config is inserted here.  The destination-pinned rollout worker writes
-- the validated mapping only after form-field/type checks and backup preflight.

CREATE OR REPLACE FUNCTION public.department_current_set_config_valid(p_config jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_typeof(p_config) = 'object'
    AND p_config->>'version' = '1'
    AND p_config ?& ARRAY[
      'department_object_id', 'workforce_object_id', 'workforce_row_object_id',
      'equipment_object_id', 'equipment_type_object_id', 'equipment_model_object_id',
      'respondent_relationship_id', 'respondent_field_key',
      'workforce_container_field_id', 'equipment_container_field_id',
      'workforce_fields', 'equipment_fields', 'relationship_keys', 'relationship_ids',
      'form_compatibility', 'required_blank_policy', 'equipment_hidden_preserve'
    ]
    AND jsonb_typeof(p_config->'workforce_fields') = 'object'
    AND jsonb_typeof(p_config->'equipment_fields') = 'object'
    AND jsonb_typeof(p_config->'relationship_keys') = 'object'
    AND jsonb_typeof(p_config->'relationship_ids') = 'object'
    AND jsonb_typeof(p_config->'form_compatibility') = 'object'
    AND p_config->'form_compatibility'->>'version' = '1'
    AND jsonb_typeof(p_config->'required_blank_policy') = 'object'
    AND jsonb_typeof(p_config->'equipment_hidden_preserve') = 'object'
    -- Form compatibility pins the reviewed child IDs. This remains narrow
    -- without baking those IDs into the reusable SQL fixture: exactly one
    -- configured hidden property is accepted, and it must be the mapped
    -- decommission year controlled by the mapped in-service field.
    AND (SELECT count(*) = 1 FROM jsonb_each(p_config->'equipment_hidden_preserve') hidden_rule
      WHERE jsonb_typeof(hidden_rule.value) = 'object'
        AND hidden_rule.value = jsonb_build_object(
          'mode', 'show_when',
          'source_field_id', hidden_rule.value->>'source_field_id',
          'value', 'No'
        )
        AND p_config->'equipment_fields'->>hidden_rule.key = 'year_decommissioned'
        AND p_config->'equipment_fields'->>(hidden_rule.value->>'source_field_id') = 'still_in_service'
    ), false);
$$;

CREATE OR REPLACE FUNCTION public.department_current_set_assert_relationship_pins(
  p_tenant_id uuid, p_config jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'workforce_department', 'workforce_row', 'equipment_department',
    'equipment_type', 'equipment_model', 'model_type'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.custom_object_relationship_definition definition
      WHERE definition.tenant_id = p_tenant_id AND definition.status = 'active'
        AND definition.id = (p_config->'relationship_ids'->>role_name)::uuid
        AND definition.relationship_key = p_config->'relationship_keys'->>role_name
        AND definition.source_kind = 'custom_object'
        AND definition.target_kind = 'custom_object'
        AND definition.source_custom_object_id = CASE role_name
          WHEN 'workforce_department' THEN (p_config->>'workforce_object_id')::uuid
          WHEN 'workforce_row' THEN (p_config->>'workforce_row_object_id')::uuid
          WHEN 'equipment_department' THEN (p_config->>'equipment_object_id')::uuid
          WHEN 'equipment_type' THEN (p_config->>'equipment_object_id')::uuid
          WHEN 'equipment_model' THEN (p_config->>'equipment_object_id')::uuid
          WHEN 'model_type' THEN (p_config->>'equipment_model_object_id')::uuid
        END
        AND definition.target_custom_object_id = CASE role_name
          WHEN 'workforce_department' THEN (p_config->>'department_object_id')::uuid
          WHEN 'workforce_row' THEN (p_config->>'workforce_object_id')::uuid
          WHEN 'equipment_department' THEN (p_config->>'department_object_id')::uuid
          WHEN 'equipment_type' THEN (p_config->>'equipment_type_object_id')::uuid
          WHEN 'equipment_model' THEN (p_config->>'equipment_model_object_id')::uuid
          WHEN 'model_type' THEN (p_config->>'equipment_type_object_id')::uuid
        END
    ) THEN
      RAISE EXCEPTION 'CURRENT_SET_INVALID: a pinned relationship definition is unavailable'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$$;

-- All configured-tenant graph writes and current-set transactions share a
-- transaction-scoped lock. A tenant-level guard deliberately avoids resolving a
-- mutable graph before acquiring its lock (especially OLD/NEW re-parenting).
-- No table locks or other tenants are involved. Versions remain per Department.
CREATE OR REPLACE FUNCTION public.department_current_set_lock(p_tenant_id uuid)
RETURNS void LANGUAGE sql VOLATILE SET search_path = public AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('department-current-set:' || p_tenant_id::text, 0));
$$;

CREATE OR REPLACE FUNCTION public.department_current_set_serialise_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  old_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  new_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
  tenant uuid;
BEGIN
  -- Lock both ownership sides in a stable order; never coalesce away OLD.
  FOR tenant IN
    SELECT DISTINCT value::uuid
    FROM unnest(ARRAY[old_row->>'tenant_id', new_row->>'tenant_id']) value
    WHERE value IS NOT NULL
      AND (TG_TABLE_NAME = 'department_current_set_config'
        OR EXISTS (SELECT 1 FROM public.department_current_set_config config
          WHERE config.tenant_id = value::uuid))
    ORDER BY value::uuid
  LOOP
    PERFORM public.department_current_set_lock(tenant);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS department_current_set_record_serialise ON public.custom_object_record;
CREATE TRIGGER department_current_set_record_serialise
  BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_record
  FOR EACH ROW EXECUTE FUNCTION public.department_current_set_serialise_change();
DROP TRIGGER IF EXISTS department_current_set_edge_serialise ON public.custom_object_relationship;
CREATE TRIGGER department_current_set_edge_serialise
  BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_relationship
  FOR EACH ROW EXECUTE FUNCTION public.department_current_set_serialise_change();
DROP TRIGGER IF EXISTS department_current_set_config_serialise ON public.department_current_set_config;
CREATE TRIGGER department_current_set_config_serialise
  BEFORE INSERT OR UPDATE OR DELETE ON public.department_current_set_config
  FOR EACH ROW EXECUTE FUNCTION public.department_current_set_serialise_change();

DROP TRIGGER IF EXISTS department_current_set_form_serialise ON public.form;
CREATE TRIGGER department_current_set_form_serialise
  BEFORE UPDATE OR DELETE ON public.form
  FOR EACH ROW EXECUTE FUNCTION public.department_current_set_serialise_change();
DROP TRIGGER IF EXISTS department_current_set_field_serialise ON public.preference_field;
CREATE TRIGGER department_current_set_field_serialise
  BEFORE INSERT OR UPDATE OR DELETE ON public.preference_field
  FOR EACH ROW EXECUTE FUNCTION public.department_current_set_serialise_change();
DROP TRIGGER IF EXISTS department_current_set_object_serialise ON public.custom_object_definition;
CREATE TRIGGER department_current_set_object_serialise
  BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_definition
  FOR EACH ROW EXECUTE FUNCTION public.department_current_set_serialise_change();
DROP TRIGGER IF EXISTS department_current_set_definition_serialise ON public.custom_object_relationship_definition;
CREATE TRIGGER department_current_set_definition_serialise
  BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_relationship_definition
  FOR EACH ROW EXECUTE FUNCTION public.department_current_set_serialise_change();

CREATE OR REPLACE FUNCTION public.department_current_set_snapshot(
  p_tenant_id uuid, p_form_id uuid, p_department_id uuid, p_config jsonb
) RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  WITH parents AS (
    SELECT e.source_record_id id FROM public.custom_object_relationship e
    WHERE e.tenant_id = p_tenant_id AND e.archived_at IS NULL
      AND e.target_record_id = p_department_id
      AND e.relationship_definition_id = (p_config->'relationship_ids'->>'workforce_department')::uuid
  ), owned AS (
    SELECT p_department_id id
    UNION SELECT id FROM parents
    UNION SELECT e.source_record_id FROM public.custom_object_relationship e
      WHERE e.tenant_id = p_tenant_id AND e.archived_at IS NULL
        AND ((e.target_record_id = p_department_id
          AND e.relationship_definition_id = (p_config->'relationship_ids'->>'equipment_department')::uuid)
        OR (e.target_record_id IN (SELECT id FROM parents)
          AND e.relationship_definition_id = (p_config->'relationship_ids'->>'workforce_row')::uuid))
  ), relevant_objects AS (
    SELECT (p_config->>'department_object_id')::uuid id
    UNION SELECT (p_config->>'workforce_object_id')::uuid
    UNION SELECT (p_config->>'workforce_row_object_id')::uuid
    UNION SELECT (p_config->>'equipment_object_id')::uuid
    UNION SELECT target_custom_object_id FROM public.custom_object_relationship_definition
      WHERE tenant_id = p_tenant_id AND id IN (
        (p_config->'relationship_ids'->>'equipment_type')::uuid,
        (p_config->'relationship_ids'->>'equipment_model')::uuid)
  ), catalogue AS (
    SELECT r.id FROM public.custom_object_record r
    WHERE r.tenant_id = p_tenant_id AND r.archived_at IS NULL
      AND r.custom_object_id IN (
        SELECT target_custom_object_id FROM public.custom_object_relationship_definition
        WHERE tenant_id = p_tenant_id AND id IN (
          (p_config->'relationship_ids'->>'equipment_type')::uuid,
          (p_config->'relationship_ids'->>'equipment_model')::uuid))
  )
  SELECT md5(jsonb_build_object(
    'config', p_config,
    'form', (SELECT to_jsonb(f) - 'updated_at' FROM public.form f
      WHERE f.tenant_id = p_tenant_id AND f.id = p_form_id),
    'department', (SELECT to_jsonb(r) FROM public.custom_object_record r
      WHERE r.tenant_id = p_tenant_id AND r.id = p_department_id AND r.archived_at IS NULL),
    'records', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
      FROM public.custom_object_record r
      WHERE r.tenant_id = p_tenant_id AND r.archived_at IS NULL
        AND r.id IN (SELECT id FROM owned)), '[]'::jsonb),
    'edges', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)
      FROM public.custom_object_relationship e
      WHERE e.tenant_id = p_tenant_id AND e.archived_at IS NULL
        AND (e.source_record_id IN (SELECT id FROM owned)
          OR e.target_record_id IN (SELECT id FROM owned)
          OR (e.source_record_id IN (SELECT id FROM catalogue)
            AND e.relationship_definition_id = (p_config->'relationship_ids'->>'model_type')::uuid))), '[]'::jsonb),
    'catalogue', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
      FROM public.custom_object_record r
      WHERE r.tenant_id = p_tenant_id AND r.archived_at IS NULL
        AND r.id IN (SELECT id FROM catalogue)), '[]'::jsonb),
    'fields', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id)
      FROM public.preference_field f WHERE f.tenant_id = p_tenant_id
        AND f.custom_object_id IN (SELECT id FROM relevant_objects)), '[]'::jsonb),
    'objects', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id)
      FROM public.custom_object_definition o WHERE o.tenant_id = p_tenant_id
        AND o.id IN (SELECT id FROM relevant_objects)), '[]'::jsonb),
    'definitions', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id)
      FROM public.custom_object_relationship_definition d WHERE d.tenant_id = p_tenant_id
        AND (d.id = (p_config->>'respondent_relationship_id')::uuid
          OR d.id IN (SELECT value::uuid FROM jsonb_each_text(p_config->'relationship_ids')))), '[]'::jsonb)
  )::text);
$$;

CREATE OR REPLACE FUNCTION public.department_current_set_assert_respondent(
  p_tenant_id uuid, p_department_id uuid, p_member_id uuid, p_config jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.custom_object_record department
    JOIN public.custom_object_relationship edge
      ON edge.tenant_id = department.tenant_id AND edge.source_record_id = department.id
      AND edge.relationship_definition_id = (p_config->>'respondent_relationship_id')::uuid
      AND edge.target_record_id = p_member_id AND edge.archived_at IS NULL
    JOIN public.custom_object_relationship_definition definition
      ON definition.id = edge.relationship_definition_id AND definition.tenant_id = edge.tenant_id
      AND definition.status = 'active' AND definition.source_kind = 'custom_object'
      AND definition.source_custom_object_id = (p_config->>'department_object_id')::uuid
      AND definition.target_kind = 'member'
    WHERE department.tenant_id = p_tenant_id AND department.id = p_department_id
      AND department.custom_object_id = (p_config->>'department_object_id')::uuid
      AND department.archived_at IS NULL
      AND edge.field_values->(p_config->>'respondent_field_key') = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: a live Survey respondent link is required'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Read projection.  row_name and other unmapped fields are intentionally never
-- returned as editable values.  They remain preserved in existing record data.
CREATE OR REPLACE FUNCTION public.department_current_set_load(
  p_tenant_id uuid, p_form_id uuid, p_department_id uuid, p_member_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cfg jsonb; wf_parent uuid; wf_count integer; version text;
BEGIN
  PERFORM public.department_current_set_lock(p_tenant_id);
  SELECT config INTO cfg FROM public.department_current_set_config
    WHERE tenant_id = p_tenant_id AND form_id = p_form_id FOR SHARE;
  IF cfg IS NULL OR NOT public.department_current_set_config_valid(cfg) THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: no valid configuration' USING ERRCODE = '22023';
  END IF;
  PERFORM public.department_current_set_assert_relationship_pins(p_tenant_id, cfg);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_department_id::text, 4471));
  PERFORM 1 FROM public.form
    WHERE tenant_id = p_tenant_id AND id = p_form_id AND is_active = true AND require_authentication = true
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: form is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM public.department_current_set_assert_respondent(p_tenant_id, p_department_id, p_member_id, cfg);
  SELECT edge.source_record_id INTO wf_parent FROM public.custom_object_relationship edge
  JOIN public.custom_object_relationship_definition definition ON definition.id = edge.relationship_definition_id
  JOIN public.custom_object_record parent ON parent.id = edge.source_record_id
    AND parent.tenant_id = edge.tenant_id AND parent.archived_at IS NULL
    AND parent.custom_object_id = (cfg->>'workforce_object_id')::uuid
  WHERE edge.tenant_id = p_tenant_id AND edge.target_record_id = p_department_id
    AND edge.archived_at IS NULL AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'workforce_department')::uuid
  ORDER BY edge.id LIMIT 1;
  SELECT count(*) INTO wf_count FROM public.custom_object_relationship edge
  JOIN public.custom_object_relationship_definition definition ON definition.id = edge.relationship_definition_id
  JOIN public.custom_object_record parent ON parent.id = edge.source_record_id
    AND parent.tenant_id = edge.tenant_id AND parent.archived_at IS NULL
    AND parent.custom_object_id = (cfg->>'workforce_object_id')::uuid
  WHERE edge.tenant_id = p_tenant_id AND edge.target_record_id = p_department_id AND edge.archived_at IS NULL
    AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'workforce_department')::uuid;
  IF wf_count > 1 THEN RAISE EXCEPTION 'CURRENT_SET_AMBIGUOUS: multiple current workforce parents' USING ERRCODE = 'P0001'; END IF;
  version := public.department_current_set_snapshot(p_tenant_id, p_form_id, p_department_id, cfg);
  RETURN jsonb_build_object(
    'version', version, 'department_id', p_department_id,
    'department', (SELECT jsonb_build_object('id', department.id,
      'label', COALESCE(department.data->>(SELECT name FROM public.preference_field
        WHERE id = (SELECT (to_jsonb(object_definition)->>'primary_display_field_id')::uuid FROM public.custom_object_definition object_definition
          WHERE tenant_id = p_tenant_id AND id = (cfg->>'department_object_id')::uuid)),
        department.data->>'department_name', department.data->>'name', department.id::text))
      FROM public.custom_object_record department
      WHERE department.tenant_id = p_tenant_id AND department.id = p_department_id AND department.archived_at IS NULL),
    'complete_sections', jsonb_build_array(cfg->>'workforce_container_field_id', cfg->>'equipment_container_field_id'),
    -- The renderer receives selected options keyed by the nested field ID.
    -- Values intentionally remain byte-for-byte canonical (not trimmed),
    -- including legacy workforce values with a trailing space.
    'option_labels', jsonb_build_object(
      (SELECT key FROM jsonb_each_text(cfg->'workforce_fields') WHERE value = 'staff_group'),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', choice, 'label', choice) ORDER BY choice)
        FROM (SELECT DISTINCT row.data->>'staff_group' choice FROM public.custom_object_record row
          JOIN public.custom_object_relationship edge ON edge.source_record_id = row.id
            AND edge.tenant_id = row.tenant_id AND edge.archived_at IS NULL
          WHERE row.tenant_id = p_tenant_id AND row.archived_at IS NULL
            AND edge.target_record_id = wf_parent AND row.data->>'staff_group' IS NOT NULL) choices), '[]'::jsonb),
      (SELECT key FROM jsonb_each_text(cfg->'workforce_fields') WHERE value = 'grade'),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', choice, 'label', choice) ORDER BY choice)
        FROM (SELECT DISTINCT row.data->>'grade' choice FROM public.custom_object_record row
          JOIN public.custom_object_relationship edge ON edge.source_record_id = row.id
            AND edge.tenant_id = row.tenant_id AND edge.archived_at IS NULL
          WHERE row.tenant_id = p_tenant_id AND row.archived_at IS NULL
            AND edge.target_record_id = wf_parent AND row.data->>'grade' IS NOT NULL) choices), '[]'::jsonb),
      (SELECT key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value = 'equipment_type_id'),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', type_record.id::text, 'label',
        COALESCE(type_record.data->>(SELECT name FROM public.preference_field
          WHERE id = (to_jsonb(type_definition)->>'primary_display_field_id')::uuid), type_record.id::text))
        ORDER BY type_record.id)
        FROM (SELECT DISTINCT type_record.* FROM public.custom_object_record equipment
          JOIN public.custom_object_relationship department_edge ON department_edge.source_record_id = equipment.id
            AND department_edge.tenant_id = equipment.tenant_id AND department_edge.archived_at IS NULL
          JOIN public.custom_object_relationship type_edge ON type_edge.source_record_id = equipment.id
            AND type_edge.tenant_id = equipment.tenant_id AND type_edge.archived_at IS NULL
          JOIN public.custom_object_relationship_definition type_relation ON type_relation.id = type_edge.relationship_definition_id
          JOIN public.custom_object_record type_record ON type_record.id = type_edge.target_record_id
            AND type_record.tenant_id = type_edge.tenant_id AND type_record.archived_at IS NULL
          WHERE equipment.tenant_id = p_tenant_id AND equipment.archived_at IS NULL
            AND department_edge.target_record_id = p_department_id
            AND type_relation.id = (cfg->'relationship_ids'->>'equipment_type')::uuid
        ) type_record JOIN public.custom_object_definition type_definition
          ON type_definition.tenant_id = p_tenant_id AND type_definition.id = type_record.custom_object_id), '[]'::jsonb),
      (SELECT key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value = 'manufacturer'),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', choice, 'label', choice) ORDER BY choice)
        FROM (SELECT DISTINCT equipment.data->>'manufacturer' choice FROM public.custom_object_record equipment
          JOIN public.custom_object_relationship department_edge ON department_edge.source_record_id = equipment.id
            AND department_edge.tenant_id = equipment.tenant_id AND department_edge.archived_at IS NULL
          WHERE equipment.tenant_id = p_tenant_id AND equipment.archived_at IS NULL
            AND department_edge.relationship_definition_id = (cfg->'relationship_ids'->>'equipment_department')::uuid
            AND department_edge.target_record_id = p_department_id AND equipment.data->>'manufacturer' IS NOT NULL) choices), '[]'::jsonb),
      (SELECT key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value = 'model_id'),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', model_record.id::text, 'label',
        COALESCE(model_record.data->>(SELECT name FROM public.preference_field
          WHERE id = (to_jsonb(model_definition)->>'primary_display_field_id')::uuid), model_record.id::text))
        ORDER BY model_record.id)
        FROM (SELECT DISTINCT model_record.* FROM public.custom_object_record equipment
          JOIN public.custom_object_relationship department_edge ON department_edge.source_record_id = equipment.id
            AND department_edge.tenant_id = equipment.tenant_id AND department_edge.archived_at IS NULL
          JOIN public.custom_object_relationship model_edge ON model_edge.source_record_id = equipment.id
            AND model_edge.tenant_id = equipment.tenant_id AND model_edge.archived_at IS NULL
          JOIN public.custom_object_record model_record ON model_record.id = model_edge.target_record_id
            AND model_record.tenant_id = model_edge.tenant_id AND model_record.archived_at IS NULL
          WHERE equipment.tenant_id = p_tenant_id AND equipment.archived_at IS NULL
            AND department_edge.relationship_definition_id = (cfg->'relationship_ids'->>'equipment_department')::uuid
            AND department_edge.target_record_id = p_department_id
            AND model_edge.relationship_definition_id = (cfg->'relationship_ids'->>'equipment_model')::uuid
        ) model_record JOIN public.custom_object_definition model_definition
          ON model_definition.tenant_id = p_tenant_id AND model_definition.id = model_record.custom_object_id), '[]'::jsonb)
    ),
    'form_values', jsonb_build_object(
      cfg->>'workforce_container_field_id', COALESCE((SELECT jsonb_agg(
        jsonb_build_object('_row_id', 'existing:' || row.id)
        || COALESCE((SELECT jsonb_object_agg(key, row.data->value)
          FROM jsonb_each_text(cfg->'workforce_fields')), '{}'::jsonb)
      ORDER BY row.id) FROM public.custom_object_record row JOIN public.custom_object_relationship edge
      ON edge.source_record_id = row.id AND edge.tenant_id = row.tenant_id AND edge.archived_at IS NULL
    JOIN public.custom_object_relationship_definition definition ON definition.id = edge.relationship_definition_id
    WHERE row.tenant_id = p_tenant_id AND row.archived_at IS NULL AND edge.target_record_id = wf_parent
      AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'workforce_row')::uuid), '[]'::jsonb),
      cfg->>'equipment_container_field_id', COALESCE((SELECT jsonb_agg(
        jsonb_build_object('_row_id', 'existing:' || equipment.id)
        || COALESCE((SELECT jsonb_object_agg(key,
          CASE value
            WHEN 'equipment_type_id' THEN to_jsonb((SELECT edge.target_record_id::text FROM public.custom_object_relationship edge
              JOIN public.custom_object_relationship_definition definition ON definition.id = edge.relationship_definition_id
              JOIN public.custom_object_record type_record ON type_record.id = edge.target_record_id
                AND type_record.tenant_id = edge.tenant_id AND type_record.archived_at IS NULL
              WHERE edge.tenant_id = equipment.tenant_id AND edge.source_record_id = equipment.id AND edge.archived_at IS NULL
                AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'equipment_type')::uuid))
            WHEN 'model_id' THEN to_jsonb((SELECT edge.target_record_id::text FROM public.custom_object_relationship edge
              JOIN public.custom_object_relationship_definition definition ON definition.id = edge.relationship_definition_id
              JOIN public.custom_object_record model_record ON model_record.id = edge.target_record_id
                AND model_record.tenant_id = edge.tenant_id AND model_record.archived_at IS NULL
              WHERE edge.tenant_id = equipment.tenant_id AND edge.source_record_id = equipment.id AND edge.archived_at IS NULL
                AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'equipment_model')::uuid))
            WHEN 'year_installed' THEN to_jsonb(equipment.data->>value)
            WHEN 'year_decommissioned' THEN to_jsonb(equipment.data->>value)
            WHEN 'manufacturer' THEN to_jsonb(COALESCE(equipment.data->>value, (
              SELECT model_record.data->>'manufacturer' FROM public.custom_object_relationship model_edge
              JOIN public.custom_object_relationship_definition model_definition ON model_definition.id = model_edge.relationship_definition_id
              JOIN public.custom_object_record model_record ON model_record.id = model_edge.target_record_id
                AND model_record.tenant_id = model_edge.tenant_id AND model_record.archived_at IS NULL
              WHERE model_edge.tenant_id = equipment.tenant_id AND model_edge.source_record_id = equipment.id
                AND model_edge.archived_at IS NULL
                AND model_edge.relationship_definition_id = (cfg->'relationship_ids'->>'equipment_model')::uuid
            )))
            ELSE equipment.data->value
          END) FROM jsonb_each_text(cfg->'equipment_fields')), '{}'::jsonb)
      ORDER BY equipment.id)
      FROM public.custom_object_record equipment JOIN public.custom_object_relationship edge
        ON edge.source_record_id = equipment.id AND edge.tenant_id = equipment.tenant_id AND edge.archived_at IS NULL
      JOIN public.custom_object_relationship_definition definition ON definition.id = edge.relationship_definition_id
      WHERE equipment.tenant_id = p_tenant_id AND equipment.archived_at IS NULL AND edge.target_record_id = p_department_id
        AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'equipment_department')::uuid), '[]'::jsonb),
      '__department_current_set', jsonb_build_object('department_id', p_department_id, 'version', version,
        'complete_sections', jsonb_build_array(cfg->>'workforce_container_field_id', cfg->>'equipment_container_field_id'))
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.department_current_set_reconcile(
  p_tenant_id uuid, p_form_id uuid, p_department_id uuid, p_member_id uuid,
  p_submission_id uuid, p_expected_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cfg jsonb; form_row public.form%ROWTYPE; submission_data jsonb; submitted_department uuid;
  workforce_rows jsonb; equipment_rows jsonb; answer_digest text; current_version text;
  existing_commit public.department_current_set_commit%ROWTYPE; wf_parent uuid; wf_parents integer;
  item jsonb; item_id uuid; existing_ids uuid[] := ARRAY[]::uuid[]; record_row public.custom_object_record%ROWTYPE;
  mapping_key text; mapping_value text; mapped jsonb; new_id uuid; relation record; result jsonb;
  type_id uuid; model_id uuid; serial_key text; installed_key text; manufacturer_key text;
  cleared_keys text[]; removed_ids uuid[];
  decommission_key text; hidden_preserve_rule jsonb; hidden_source_key text; hidden_source_value text;
BEGIN
  PERFORM public.department_current_set_lock(p_tenant_id);
  -- A scoped lock serialises only one Department.  Configuration and form rows
  -- are separately shared-locked below so an audience/config edit cannot race
  -- the authorization or version check.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_department_id::text, 4471));
  SELECT config INTO cfg FROM public.department_current_set_config
    WHERE tenant_id = p_tenant_id AND form_id = p_form_id FOR SHARE;
  SELECT * INTO form_row FROM public.form WHERE tenant_id = p_tenant_id AND id = p_form_id AND is_active = true FOR SHARE;
  IF cfg IS NULL OR form_row.id IS NULL OR NOT form_row.require_authentication
     OR NOT public.department_current_set_config_valid(cfg) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: form is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM public.department_current_set_assert_relationship_pins(p_tenant_id, cfg);
  SELECT submission.submission_data INTO submission_data FROM public.form_submission submission
    WHERE submission.id = p_submission_id AND submission.tenant_id = p_tenant_id
      AND submission.form_id = p_form_id FOR SHARE;
  IF submission_data IS NULL OR jsonb_typeof(submission_data) <> 'object' THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: durable submission data is unavailable' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.form_submission
    WHERE id = p_submission_id AND tenant_id = p_tenant_id AND form_id = p_form_id
      AND created_member_id = p_member_id
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: submission actor does not match the signed member'
      USING ERRCODE = '42501';
  END IF;
  answer_digest := md5(submission_data::text);
  SELECT * INTO existing_commit FROM public.department_current_set_commit
    WHERE tenant_id = p_tenant_id AND form_id = p_form_id AND submission_id = p_submission_id FOR SHARE;
  IF existing_commit.submission_id IS NOT NULL THEN
    IF existing_commit.department_id <> p_department_id OR existing_commit.answer_digest <> answer_digest THEN
      RAISE EXCEPTION 'CURRENT_SET_CONFLICT: submission was already committed with different current-set data' USING ERRCODE = '40001';
    END IF;
    RETURN existing_commit.response || jsonb_build_object('status', 'replayed');
  END IF;
  submitted_department := (submission_data->'__department_current_set'->>'department_id')::uuid;
  workforce_rows := submission_data->(cfg->>'workforce_container_field_id');
  equipment_rows := submission_data->(cfg->>'equipment_container_field_id');
  IF submitted_department IS DISTINCT FROM p_department_id OR jsonb_typeof(workforce_rows) <> 'array'
     OR jsonb_typeof(equipment_rows) <> 'array'
     OR NOT ((submission_data->'__department_current_set'->'complete_sections') ? (cfg->>'workforce_container_field_id'))
     OR NOT ((submission_data->'__department_current_set'->'complete_sections') ? (cfg->>'equipment_container_field_id')) THEN
    RAISE EXCEPTION 'CURRENT_SET_INCOMPLETE: both loaded sections are required' USING ERRCODE = '22023';
  END IF;
  PERFORM public.department_current_set_assert_respondent(p_tenant_id, p_department_id, p_member_id, cfg);
  current_version := public.department_current_set_snapshot(p_tenant_id, p_form_id, p_department_id, cfg);
  IF current_version IS DISTINCT FROM p_expected_version
     OR (submission_data->'__department_current_set'->>'version') IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'CURRENT_SET_CONFLICT: current department data changed; reload and review it before saving' USING ERRCODE = '40001';
  END IF;
  SELECT count(*), (array_agg(edge.source_record_id ORDER BY edge.id))[1] INTO wf_parents, wf_parent FROM public.custom_object_relationship edge
  JOIN public.custom_object_relationship_definition definition ON definition.id = edge.relationship_definition_id
  JOIN public.custom_object_record parent ON parent.id = edge.source_record_id
    AND parent.tenant_id = edge.tenant_id AND parent.archived_at IS NULL
    AND parent.custom_object_id = (cfg->>'workforce_object_id')::uuid
  WHERE edge.tenant_id = p_tenant_id AND edge.target_record_id = p_department_id AND edge.archived_at IS NULL
    AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'workforce_department')::uuid;
  IF wf_parents > 1 THEN RAISE EXCEPTION 'CURRENT_SET_AMBIGUOUS: multiple current workforce parents' USING ERRCODE = 'P0001'; END IF;

  -- Existing IDs are checked against the authoritative current set before any
  -- update.  `_row_id` is an identity hint, never authorization.
  FOR item IN SELECT value FROM jsonb_array_elements(workforce_rows)
  LOOP
    IF jsonb_typeof(item) <> 'object' THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: invalid workforce row' USING ERRCODE = '22023'; END IF;
    IF item ? '_row_id' AND item->>'_row_id' LIKE 'existing:%' THEN
      item_id := substring(item->>'_row_id' from 10)::uuid;
      IF item_id = ANY(existing_ids) OR NOT EXISTS (SELECT 1 FROM public.custom_object_relationship edge
        JOIN public.custom_object_relationship_definition definition ON definition.id = edge.relationship_definition_id
        JOIN public.custom_object_record existing_row ON existing_row.id = edge.source_record_id
          AND existing_row.tenant_id = edge.tenant_id AND existing_row.archived_at IS NULL
          AND existing_row.custom_object_id = (cfg->>'workforce_row_object_id')::uuid
        WHERE edge.tenant_id = p_tenant_id AND edge.source_record_id = item_id AND edge.target_record_id = wf_parent
          AND edge.archived_at IS NULL AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'workforce_row')::uuid) THEN
        RAISE EXCEPTION 'CURRENT_SET_INVALID: workforce row does not belong to this Department' USING ERRCODE = '22023';
      END IF;
      IF (SELECT count(*) FROM public.custom_object_relationship owned_edge
        WHERE owned_edge.tenant_id = p_tenant_id AND owned_edge.source_record_id = item_id
          AND owned_edge.archived_at IS NULL
          AND owned_edge.relationship_definition_id = (cfg->'relationship_ids'->>'workforce_row')::uuid) <> 1 THEN
        RAISE EXCEPTION 'CURRENT_SET_AMBIGUOUS: workforce row has multiple current parents' USING ERRCODE = 'P0001';
      END IF;
      existing_ids := array_append(existing_ids, item_id);
    END IF;
  END LOOP;
  IF wf_parent IS NULL THEN
    INSERT INTO public.custom_object_record (tenant_id, custom_object_id, data, created_by, updated_by)
      VALUES (p_tenant_id, (cfg->>'workforce_object_id')::uuid, jsonb_build_object('survey_name', 'Current workforce'),
        'member:' || p_member_id, 'member:' || p_member_id) RETURNING id INTO wf_parent;
    SELECT * INTO relation FROM public.custom_object_relationship_definition WHERE tenant_id = p_tenant_id
      AND id = (cfg->'relationship_ids'->>'workforce_department')::uuid AND status = 'active';
    INSERT INTO public.custom_object_relationship (tenant_id, relationship_definition_id, source_record_id, target_record_id, created_by)
      VALUES (p_tenant_id, relation.id, wf_parent, p_department_id, 'member:' || p_member_id);
  END IF;
  existing_ids := ARRAY[]::uuid[];
  FOR item IN SELECT value FROM jsonb_array_elements(workforce_rows)
  LOOP
    mapped := '{}'::jsonb; cleared_keys := ARRAY[]::text[];
    FOR mapping_key, mapping_value IN SELECT entry.key, entry.value FROM jsonb_each_text(cfg->'workforce_fields') entry LOOP
      IF item ? mapping_key AND COALESCE(item->>mapping_key, '') = '' THEN
        cleared_keys := array_append(cleared_keys, mapping_value);
      ELSIF item ? mapping_key THEN
        mapped := mapped || jsonb_build_object(mapping_value,
          CASE WHEN mapping_value IN ('occupied_wte', 'vacant_wte') THEN to_jsonb((item->>mapping_key)::numeric) ELSE item->mapping_key END);
      END IF;
    END LOOP;
    IF item ? '_row_id' AND item->>'_row_id' LIKE 'existing:%' THEN
      item_id := substring(item->>'_row_id' from 10)::uuid; existing_ids := array_append(existing_ids, item_id);
      UPDATE public.custom_object_record SET data = (data || mapped) - cleared_keys, updated_at = now(), updated_by = 'member:' || p_member_id
        WHERE tenant_id = p_tenant_id AND id = item_id AND archived_at IS NULL;
    ELSE
      INSERT INTO public.custom_object_record (tenant_id, custom_object_id, data, created_by, updated_by)
        VALUES (p_tenant_id, (cfg->>'workforce_row_object_id')::uuid,
          mapped || jsonb_build_object('row_name', 'Current workforce row ' || gen_random_uuid()::text),
          'member:' || p_member_id, 'member:' || p_member_id) RETURNING id INTO new_id;
      SELECT * INTO relation FROM public.custom_object_relationship_definition WHERE tenant_id = p_tenant_id
        AND id = (cfg->'relationship_ids'->>'workforce_row')::uuid AND status = 'active';
      INSERT INTO public.custom_object_relationship (tenant_id, relationship_definition_id, source_record_id, target_record_id, created_by)
        VALUES (p_tenant_id, relation.id, new_id, wf_parent, 'member:' || p_member_id);
      existing_ids := array_append(existing_ids, new_id);
    END IF;
  END LOOP;
  -- Archive only rows that were active in this exact current set at the
  -- snapshot. Historical archived edges cannot make a record eligible.
  SELECT COALESCE(array_agg(edge.source_record_id), ARRAY[]::uuid[]) INTO removed_ids
    FROM public.custom_object_relationship edge JOIN public.custom_object_relationship_definition definition
      ON definition.id = edge.relationship_definition_id
    WHERE edge.tenant_id = p_tenant_id AND edge.target_record_id = wf_parent AND edge.archived_at IS NULL
      AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'workforce_row')::uuid
      AND NOT edge.source_record_id = ANY(existing_ids);
  UPDATE public.custom_object_relationship SET archived_at = now(), archived_by = 'member:' || p_member_id
    WHERE tenant_id = p_tenant_id AND target_record_id = wf_parent AND archived_at IS NULL
      AND relationship_definition_id = (cfg->'relationship_ids'->>'workforce_row')::uuid
      AND source_record_id = ANY(removed_ids);
  UPDATE public.custom_object_record SET archived_at = now(), archived_by = 'member:' || p_member_id, archive_reason = 'Removed from Department current set'
    WHERE tenant_id = p_tenant_id AND id = ANY(removed_ids) AND archived_at IS NULL;

  -- Equipment follows the same retain/create/archive protocol.  Catalogue
  -- endpoints are intentionally only read/validated; no Type or Model record
  -- is ever updated here.
  existing_ids := ARRAY[]::uuid[];
  SELECT entry.key INTO serial_key FROM jsonb_each_text(cfg->'equipment_fields') entry WHERE entry.value = 'serial_number';
  SELECT entry.key INTO installed_key FROM jsonb_each_text(cfg->'equipment_fields') entry WHERE entry.value = 'year_installed';
  SELECT entry.key INTO manufacturer_key FROM jsonb_each_text(cfg->'equipment_fields') entry WHERE entry.value = 'manufacturer';
  SELECT entry.key INTO decommission_key FROM jsonb_each_text(cfg->'equipment_fields') entry WHERE entry.value = 'year_decommissioned';
  hidden_preserve_rule := cfg->'equipment_hidden_preserve'->decommission_key;
  hidden_source_key := hidden_preserve_rule->>'source_field_id';
  hidden_source_value := hidden_preserve_rule->>'value';
  FOR item IN SELECT value FROM jsonb_array_elements(equipment_rows)
  LOOP
    IF jsonb_typeof(item) <> 'object' THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: invalid equipment row' USING ERRCODE = '22023'; END IF;
    IF item ? '_row_id' AND item->>'_row_id' LIKE 'existing:%' THEN
      item_id := substring(item->>'_row_id' from 10)::uuid;
      IF item_id = ANY(existing_ids) OR NOT EXISTS (SELECT 1 FROM public.custom_object_relationship edge
        JOIN public.custom_object_relationship_definition definition ON definition.id = edge.relationship_definition_id
        JOIN public.custom_object_record existing_equipment ON existing_equipment.id = edge.source_record_id
          AND existing_equipment.tenant_id = edge.tenant_id AND existing_equipment.archived_at IS NULL
          AND existing_equipment.custom_object_id = (cfg->>'equipment_object_id')::uuid
        WHERE edge.tenant_id = p_tenant_id AND edge.source_record_id = item_id AND edge.target_record_id = p_department_id
          AND edge.archived_at IS NULL AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'equipment_department')::uuid) THEN
        RAISE EXCEPTION 'CURRENT_SET_INVALID: equipment row does not belong to this Department' USING ERRCODE = '22023';
      END IF;
      IF (SELECT count(*) FROM public.custom_object_relationship owned_edge
        WHERE owned_edge.tenant_id = p_tenant_id AND owned_edge.source_record_id = item_id
          AND owned_edge.archived_at IS NULL
          AND owned_edge.relationship_definition_id = (cfg->'relationship_ids'->>'equipment_department')::uuid) <> 1 THEN
        RAISE EXCEPTION 'CURRENT_SET_AMBIGUOUS: equipment record has multiple current Departments' USING ERRCODE = 'P0001';
      END IF;
      SELECT * INTO record_row FROM public.custom_object_record
        WHERE tenant_id = p_tenant_id AND id = item_id AND archived_at IS NULL FOR SHARE;
      IF COALESCE(record_row.data->>'serial_number', '') <> '' AND COALESCE(item->>serial_key, '') = '' THEN
        RAISE EXCEPTION 'CURRENT_SET_INVALID: an existing serial number cannot be cleared' USING ERRCODE = '22023';
      END IF;
      IF COALESCE(record_row.data->>'year_installed', '') <> '' AND COALESCE(item->>installed_key, '') = '' THEN
        RAISE EXCEPTION 'CURRENT_SET_INVALID: an existing installation year cannot be cleared' USING ERRCODE = '22023';
      END IF;
      existing_ids := array_append(existing_ids, item_id);
    ELSIF COALESCE(item->>serial_key, '') = '' OR COALESCE(item->>installed_key, '') !~ '^[0-9]{4}$' THEN
      RAISE EXCEPTION 'CURRENT_SET_INVALID: new equipment requires serial number and a whole installation year' USING ERRCODE = '22023';
    END IF;
    IF item ? installed_key AND COALESCE(item->>installed_key, '') <> ''
       AND item->>installed_key !~ '^[0-9]{4}$' THEN
      RAISE EXCEPTION 'CURRENT_SET_INVALID: installation year must be a whole year' USING ERRCODE = '22023';
    END IF;
    IF item->>hidden_source_key = hidden_source_value AND item ? decommission_key
       AND COALESCE(item->>decommission_key, '') <> ''
       AND item->>decommission_key !~ '^[0-9]{4}$' THEN
      RAISE EXCEPTION 'CURRENT_SET_INVALID: decommissioning year must be a whole year' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(equipment_rows)
  LOOP
    type_id := NULLIF(item->>(SELECT entry.key FROM jsonb_each_text(cfg->'equipment_fields') entry WHERE entry.value = 'equipment_type_id'), '')::uuid;
    model_id := NULLIF(item->>(SELECT entry.key FROM jsonb_each_text(cfg->'equipment_fields') entry WHERE entry.value = 'model_id'), '')::uuid;
    SELECT * INTO relation FROM public.custom_object_relationship_definition WHERE tenant_id = p_tenant_id
      AND id = (cfg->'relationship_ids'->>'equipment_type')::uuid AND status = 'active' FOR SHARE;
    IF relation.id IS NULL OR type_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.custom_object_record
      WHERE tenant_id = p_tenant_id AND id = type_id AND custom_object_id = relation.target_custom_object_id AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'CURRENT_SET_INVALID: equipment Type is not an active catalogue record' USING ERRCODE = '22023';
    END IF;
    IF model_id IS NOT NULL THEN
      SELECT * INTO relation FROM public.custom_object_relationship_definition WHERE tenant_id = p_tenant_id
        AND id = (cfg->'relationship_ids'->>'equipment_model')::uuid AND status = 'active' FOR SHARE;
      IF relation.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.custom_object_record model
        WHERE model.tenant_id = p_tenant_id AND model.id = model_id
          AND model.custom_object_id = relation.target_custom_object_id AND model.archived_at IS NULL
          AND model.data->>'manufacturer' = item->>manufacturer_key)
        OR NOT EXISTS (SELECT 1 FROM public.custom_object_relationship model_type
          WHERE model_type.tenant_id = p_tenant_id AND model_type.source_record_id = model_id
            AND model_type.target_record_id = type_id AND model_type.archived_at IS NULL
            AND model_type.relationship_definition_id = (cfg->'relationship_ids'->>'model_type')::uuid) THEN
        RAISE EXCEPTION 'CURRENT_SET_INVALID: Model does not match Type and Manufacturer' USING ERRCODE = '22023';
      END IF;
    ELSIF COALESCE(item->>manufacturer_key, '') <> '' AND NOT EXISTS (
      SELECT 1 FROM public.custom_object_record model
      WHERE model.tenant_id = p_tenant_id AND model.archived_at IS NULL
        AND model.data->>'manufacturer' = item->>manufacturer_key
        AND EXISTS (SELECT 1 FROM public.custom_object_relationship model_type
          WHERE model_type.tenant_id = p_tenant_id AND model_type.source_record_id = model.id
            AND model_type.target_record_id = type_id AND model_type.archived_at IS NULL
            AND model_type.relationship_definition_id = (cfg->'relationship_ids'->>'model_type')::uuid)
    ) THEN
      RAISE EXCEPTION 'CURRENT_SET_INVALID: Manufacturer is not available for the selected Type' USING ERRCODE = '22023';
    END IF;
    mapped := '{}'::jsonb; cleared_keys := ARRAY[]::text[];
    FOR mapping_key, mapping_value IN SELECT entry.key, entry.value FROM jsonb_each_text(cfg->'equipment_fields') entry LOOP
      IF mapping_value NOT IN ('equipment_type_id', 'model_id') AND item ? mapping_key THEN
        -- No other hidden child is supported.  A hidden decommissioning year
        -- is authoritative server data: ignore forged input and, critically,
        -- do not add it to cleared_keys.
        IF mapping_key = decommission_key AND item->>hidden_source_key IS DISTINCT FROM hidden_source_value THEN
          CONTINUE;
        ELSIF COALESCE(item->>mapping_key, '') = '' THEN
          cleared_keys := array_append(cleared_keys, mapping_value);
        ELSE
          mapped := mapped || jsonb_build_object(mapping_value,
            CASE WHEN mapping_value IN ('year_installed', 'year_decommissioned') THEN to_jsonb((item->>mapping_key)::numeric) ELSE item->mapping_key END);
        END IF;
      END IF;
    END LOOP;
    IF item ? '_row_id' AND item->>'_row_id' LIKE 'existing:%' THEN
      item_id := substring(item->>'_row_id' from 10)::uuid; existing_ids := array_append(existing_ids, item_id);
      UPDATE public.custom_object_record SET data = (data || mapped) - cleared_keys, updated_at = now(), updated_by = 'member:' || p_member_id
        WHERE tenant_id = p_tenant_id AND id = item_id AND archived_at IS NULL;
    ELSE
      INSERT INTO public.custom_object_record (tenant_id, custom_object_id, data, created_by, updated_by)
        VALUES (p_tenant_id, (cfg->>'equipment_object_id')::uuid, mapped, 'member:' || p_member_id, 'member:' || p_member_id)
        RETURNING id INTO item_id;
      SELECT * INTO relation FROM public.custom_object_relationship_definition WHERE tenant_id = p_tenant_id
        AND id = (cfg->'relationship_ids'->>'equipment_department')::uuid AND status = 'active';
      INSERT INTO public.custom_object_relationship (tenant_id, relationship_definition_id, source_record_id, target_record_id, created_by)
        VALUES (p_tenant_id, relation.id, item_id, p_department_id, 'member:' || p_member_id);
      existing_ids := array_append(existing_ids, item_id);
    END IF;
    FOR relation IN SELECT * FROM public.custom_object_relationship_definition WHERE tenant_id = p_tenant_id AND status = 'active'
      AND id IN ((cfg->'relationship_ids'->>'equipment_type')::uuid, (cfg->'relationship_ids'->>'equipment_model')::uuid)
    LOOP
      UPDATE public.custom_object_relationship SET archived_at = now(), archived_by = 'member:' || p_member_id
        WHERE tenant_id = p_tenant_id AND source_record_id = item_id AND relationship_definition_id = relation.id
          AND archived_at IS NULL AND (relation.id <> (cfg->'relationship_ids'->>'equipment_type')::uuid OR target_record_id <> type_id)
          AND (relation.id <> (cfg->'relationship_ids'->>'equipment_model')::uuid OR model_id IS NULL OR target_record_id <> model_id);
      IF (relation.id = (cfg->'relationship_ids'->>'equipment_type')::uuid)
         OR (relation.id = (cfg->'relationship_ids'->>'equipment_model')::uuid AND model_id IS NOT NULL) THEN
        INSERT INTO public.custom_object_relationship (tenant_id, relationship_definition_id, source_record_id, target_record_id, created_by)
        SELECT p_tenant_id, relation.id, item_id,
          CASE WHEN relation.id = (cfg->'relationship_ids'->>'equipment_type')::uuid THEN type_id ELSE model_id END,
          'member:' || p_member_id
        WHERE NOT EXISTS (SELECT 1 FROM public.custom_object_relationship current_edge WHERE current_edge.tenant_id = p_tenant_id
          AND current_edge.relationship_definition_id = relation.id AND current_edge.source_record_id = item_id
          AND current_edge.target_record_id = CASE WHEN relation.id = (cfg->'relationship_ids'->>'equipment_type')::uuid THEN type_id ELSE model_id END
          AND current_edge.archived_at IS NULL);
      END IF;
    END LOOP;
  END LOOP;
  SELECT COALESCE(array_agg(edge.source_record_id), ARRAY[]::uuid[]) INTO removed_ids
    FROM public.custom_object_relationship edge JOIN public.custom_object_relationship_definition definition
      ON definition.id = edge.relationship_definition_id WHERE edge.tenant_id = p_tenant_id AND edge.target_record_id = p_department_id
        AND edge.archived_at IS NULL AND edge.relationship_definition_id = (cfg->'relationship_ids'->>'equipment_department')::uuid
        AND NOT edge.source_record_id = ANY(existing_ids);
  UPDATE public.custom_object_relationship SET archived_at = now(), archived_by = 'member:' || p_member_id
    WHERE tenant_id = p_tenant_id AND source_record_id = ANY(removed_ids)
      AND archived_at IS NULL AND relationship_definition_id IN (
        (cfg->'relationship_ids'->>'equipment_department')::uuid,
        (cfg->'relationship_ids'->>'equipment_type')::uuid,
        (cfg->'relationship_ids'->>'equipment_model')::uuid);
  UPDATE public.custom_object_record SET archived_at = now(), archived_by = 'member:' || p_member_id, archive_reason = 'Removed from Department current set'
    WHERE tenant_id = p_tenant_id AND id = ANY(removed_ids) AND archived_at IS NULL;
  result := public.department_current_set_load(p_tenant_id, p_form_id, p_department_id, p_member_id)
    || jsonb_build_object('status', 'committed');
  INSERT INTO public.department_current_set_commit (tenant_id, form_id, department_id, submission_id, answer_digest, response)
    VALUES (p_tenant_id, p_form_id, p_department_id, p_submission_id, answer_digest, result);
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.department_current_set_load(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.department_current_set_load(uuid, uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.department_current_set_reconcile(uuid, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.department_current_set_reconcile(uuid, uuid, uuid, uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.department_current_set_assert_respondent(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_snapshot(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_serialise_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_lock(uuid) FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';