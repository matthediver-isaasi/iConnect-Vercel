-- Department current-set v2: workforce rows now belong directly to Departments.
-- This is deliberately an additive replacement of the v1 RPC bodies.  It does
-- not move data, create a Workforce Survey, or modify configuration rows.

CREATE OR REPLACE FUNCTION public.department_current_set_config_valid(p_config jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_typeof(p_config) = 'object'
    AND p_config->>'version' = '2'
    AND NOT p_config ? 'workforce_object_id'
    AND p_config ?& ARRAY[
      'department_object_id', 'workforce_row_object_id', 'equipment_object_id',
      'equipment_type_object_id', 'equipment_model_object_id',
      'respondent_relationship_id', 'respondent_field_key',
      'workforce_container_field_id', 'equipment_container_field_id',
      'workforce_fields', 'equipment_fields', 'relationship_keys', 'relationship_ids',
      'form_compatibility', 'required_blank_policy', 'equipment_hidden_preserve'
    ]
    AND NOT p_config->'relationship_keys' ? 'workforce_row'
    AND NOT p_config->'relationship_ids' ? 'workforce_row'
    AND jsonb_typeof(p_config->'workforce_fields') = 'object'
    AND jsonb_typeof(p_config->'equipment_fields') = 'object'
    AND jsonb_typeof(p_config->'relationship_keys') = 'object'
    AND jsonb_typeof(p_config->'relationship_ids') = 'object'
    AND jsonb_typeof(p_config->'form_compatibility') = 'object'
    AND p_config->'form_compatibility'->>'version' = '1'
    AND jsonb_typeof(p_config->'required_blank_policy') = 'object'
    AND jsonb_typeof(p_config->'equipment_hidden_preserve') = 'object'
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
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'workforce_department', 'equipment_department', 'equipment_type',
    'equipment_model', 'model_type'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.custom_object_relationship_definition definition
      WHERE definition.tenant_id = p_tenant_id AND definition.status = 'active'
        AND definition.id = (p_config->'relationship_ids'->>role_name)::uuid
        AND definition.relationship_key = p_config->'relationship_keys'->>role_name
        AND definition.source_kind = 'custom_object'
        AND definition.target_kind = 'custom_object'
        AND definition.source_custom_object_id = CASE role_name
          WHEN 'workforce_department' THEN (p_config->>'workforce_row_object_id')::uuid
          WHEN 'equipment_department' THEN (p_config->>'equipment_object_id')::uuid
          WHEN 'equipment_type' THEN (p_config->>'equipment_object_id')::uuid
          WHEN 'equipment_model' THEN (p_config->>'equipment_object_id')::uuid
          WHEN 'model_type' THEN (p_config->>'equipment_model_object_id')::uuid
        END
        AND definition.target_custom_object_id = CASE role_name
          WHEN 'workforce_department' THEN (p_config->>'department_object_id')::uuid
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
  IF NOT EXISTS (
    SELECT 1 FROM public.custom_object_definition object_definition
    JOIN public.preference_field field
      ON field.id = object_definition.primary_display_field_id
     AND field.tenant_id = object_definition.tenant_id
    WHERE object_definition.tenant_id = p_tenant_id
      AND object_definition.id = (p_config->>'workforce_row_object_id')::uuid
      AND object_definition.status = 'active'
      AND field.custom_object_id = object_definition.id
      AND field.name = 'staff_group' AND field.field_type = 'dropdown' AND field.is_active
      AND EXISTS (SELECT 1 FROM jsonb_each_text(p_config->'workforce_fields')
        WHERE value = 'staff_group')
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: staff_group must be the active workforce primary field'
      USING ERRCODE = '22023';
  END IF;
  -- The direct Workforce contract is one required row-to-Department edge.
  IF NOT EXISTS (
    SELECT 1 FROM public.custom_object_relationship_definition definition
    WHERE definition.tenant_id = p_tenant_id
      AND definition.id = (p_config->'relationship_ids'->>'workforce_department')::uuid
      AND definition.cardinality = 'many_to_one' AND definition.is_required
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: workforce rows must have one required Department'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.department_current_set_snapshot(
  p_tenant_id uuid, p_form_id uuid, p_department_id uuid, p_config jsonb
) RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  WITH owned AS (
    SELECT p_department_id id
    UNION
    SELECT e.source_record_id FROM public.custom_object_relationship e
    WHERE e.tenant_id = p_tenant_id AND e.archived_at IS NULL
      AND e.target_record_id = p_department_id
      AND e.relationship_definition_id IN (
        (p_config->'relationship_ids'->>'workforce_department')::uuid,
        (p_config->'relationship_ids'->>'equipment_department')::uuid)
  ), relevant_objects AS (
    SELECT (p_config->>'department_object_id')::uuid id
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
      FROM public.custom_object_record r WHERE r.tenant_id = p_tenant_id
        AND r.archived_at IS NULL AND r.id IN (SELECT id FROM owned)), '[]'::jsonb),
    'edges', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)
      FROM public.custom_object_relationship e WHERE e.tenant_id = p_tenant_id
        AND e.archived_at IS NULL AND (e.source_record_id IN (SELECT id FROM owned)
          OR e.target_record_id IN (SELECT id FROM owned)
          OR (e.source_record_id IN (SELECT id FROM catalogue)
            AND e.relationship_definition_id = (p_config->'relationship_ids'->>'model_type')::uuid))), '[]'::jsonb),
    'catalogue', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
      FROM public.custom_object_record r WHERE r.tenant_id = p_tenant_id
        AND r.archived_at IS NULL AND r.id IN (SELECT id FROM catalogue)), '[]'::jsonb),
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

CREATE OR REPLACE FUNCTION public.department_current_set_assert_new_workforce_row(
  p_tenant_id uuid, p_config jsonb, p_item jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- New data must meet the active record contract.  An inactive row_name is
  -- therefore neither required nor written, while an unmapped active required
  -- field fails closed rather than receiving an invented value.
  IF EXISTS (
    SELECT 1 FROM public.preference_field f
    LEFT JOIN jsonb_each_text(p_config->'workforce_fields') mapping ON mapping.value = f.name
    WHERE f.tenant_id = p_tenant_id
      AND f.custom_object_id = (p_config->>'workforce_row_object_id')::uuid
      AND f.is_active AND f.is_required
      AND (mapping.key IS NULL OR NOT p_item ? mapping.key
        OR p_item->mapping.key = 'null'::jsonb
        OR (f.field_type IN ('text', 'textarea', 'dropdown') AND COALESCE(p_item->>mapping.key, '') = ''))
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: new workforce row is missing an active required field'
      USING ERRCODE = '22023';
  END IF;
  -- Do not trim. Dropdown choices are canonical persisted values, including a
  -- deliberate trailing space in an existing Staff group.
  IF EXISTS (
    SELECT 1 FROM public.preference_field f
    JOIN jsonb_each_text(p_config->'workforce_fields') mapping ON mapping.value = f.name
    WHERE f.tenant_id = p_tenant_id
      AND f.custom_object_id = (p_config->>'workforce_row_object_id')::uuid
      AND f.is_active AND f.field_type = 'dropdown' AND p_item ? mapping.key
      AND (jsonb_typeof(p_item->mapping.key) <> 'string'
        OR jsonb_typeof(f.options) <> 'array'
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.options) option
          WHERE (jsonb_typeof(option) = 'string' AND option #>> '{}' = p_item->>mapping.key)
             OR (jsonb_typeof(option) = 'object' AND option->>'value' = p_item->>mapping.key)))
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: workforce dropdown value is not an exact canonical option'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.department_current_set_load(
  p_tenant_id uuid, p_form_id uuid, p_department_id uuid, p_member_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cfg jsonb; version text;
BEGIN
  PERFORM public.department_current_set_lock(p_tenant_id);
  SELECT config INTO cfg FROM public.department_current_set_config
    WHERE tenant_id = p_tenant_id AND form_id = p_form_id FOR SHARE;
  IF cfg IS NULL OR NOT public.department_current_set_config_valid(cfg) THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: no valid configuration' USING ERRCODE = '22023';
  END IF;
  PERFORM public.department_current_set_assert_relationship_pins(p_tenant_id, cfg);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_department_id::text, 4471));
  PERFORM 1 FROM public.form WHERE tenant_id=p_tenant_id AND id=p_form_id
    AND is_active AND require_authentication FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: form is unavailable' USING ERRCODE='42501'; END IF;
  PERFORM public.department_current_set_assert_respondent(p_tenant_id,p_department_id,p_member_id,cfg);
  version := public.department_current_set_snapshot(p_tenant_id,p_form_id,p_department_id,cfg);
  RETURN jsonb_build_object(
    'version',version,'department_id',p_department_id,
    'department',(SELECT jsonb_build_object('id',d.id,'label',COALESCE(d.data->>(
      SELECT name FROM public.preference_field WHERE id=(SELECT (to_jsonb(o)->>'primary_display_field_id')::uuid
        FROM public.custom_object_definition o WHERE o.tenant_id=p_tenant_id AND o.id=(cfg->>'department_object_id')::uuid)),
      d.data->>'department_name',d.data->>'name',d.id::text)) FROM public.custom_object_record d
      WHERE d.tenant_id=p_tenant_id AND d.id=p_department_id AND d.archived_at IS NULL),
    'complete_sections',jsonb_build_array(cfg->>'workforce_container_field_id',cfg->>'equipment_container_field_id'),
    'option_labels',jsonb_build_object(
      (SELECT key FROM jsonb_each_text(cfg->'workforce_fields') WHERE value='staff_group'),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value',choice,'label',choice) ORDER BY choice)
        FROM (SELECT DISTINCT row.data->>'staff_group' choice FROM public.custom_object_record row
          JOIN public.custom_object_relationship edge ON edge.source_record_id=row.id AND edge.tenant_id=row.tenant_id AND edge.archived_at IS NULL
          WHERE row.tenant_id=p_tenant_id AND row.archived_at IS NULL AND edge.target_record_id=p_department_id
            AND edge.relationship_definition_id=(cfg->'relationship_ids'->>'workforce_department')::uuid
            AND row.data->>'staff_group' IS NOT NULL) choices),'[]'::jsonb),
      (SELECT key FROM jsonb_each_text(cfg->'workforce_fields') WHERE value='grade'),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value',choice,'label',choice) ORDER BY choice)
        FROM (SELECT DISTINCT row.data->>'grade' choice FROM public.custom_object_record row
          JOIN public.custom_object_relationship edge ON edge.source_record_id=row.id AND edge.tenant_id=row.tenant_id AND edge.archived_at IS NULL
          WHERE row.tenant_id=p_tenant_id AND row.archived_at IS NULL AND edge.target_record_id=p_department_id
            AND edge.relationship_definition_id=(cfg->'relationship_ids'->>'workforce_department')::uuid
            AND row.data->>'grade' IS NOT NULL) choices),'[]'::jsonb),
      (SELECT key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value='equipment_type_id'),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value',r.id::text,'label',COALESCE(r.data->>'name',r.id::text)) ORDER BY r.id)
        FROM public.custom_object_record r WHERE r.tenant_id=p_tenant_id AND r.archived_at IS NULL
          AND r.custom_object_id=(cfg->>'equipment_type_object_id')::uuid),'[]'::jsonb),
      (SELECT key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value='manufacturer'),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value',choice,'label',choice) ORDER BY choice)
        FROM (SELECT DISTINCT data->>'manufacturer' choice FROM public.custom_object_record
          WHERE tenant_id=p_tenant_id AND custom_object_id=(cfg->>'equipment_model_object_id')::uuid
            AND archived_at IS NULL AND data->>'manufacturer' IS NOT NULL) choices),'[]'::jsonb),
      (SELECT key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value='model_id'),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value',r.id::text,'label',COALESCE(r.data->>'name',r.id::text)) ORDER BY r.id)
        FROM public.custom_object_record r WHERE r.tenant_id=p_tenant_id AND r.archived_at IS NULL
          AND r.custom_object_id=(cfg->>'equipment_model_object_id')::uuid),'[]'::jsonb)),
    'form_values',jsonb_build_object(
      cfg->>'workforce_container_field_id',COALESCE((SELECT jsonb_agg(jsonb_build_object('_row_id','existing:'||row.id)
        || COALESCE((SELECT jsonb_object_agg(key,row.data->value) FROM jsonb_each_text(cfg->'workforce_fields')),'{}'::jsonb) ORDER BY row.id)
        FROM public.custom_object_record row JOIN public.custom_object_relationship edge
          ON edge.source_record_id=row.id AND edge.tenant_id=row.tenant_id AND edge.archived_at IS NULL
        WHERE row.tenant_id=p_tenant_id AND row.archived_at IS NULL AND edge.target_record_id=p_department_id
          AND edge.relationship_definition_id=(cfg->'relationship_ids'->>'workforce_department')::uuid),'[]'::jsonb),
      cfg->>'equipment_container_field_id',COALESCE((SELECT jsonb_agg(jsonb_build_object('_row_id','existing:'||equipment.id)
        || COALESCE((SELECT jsonb_object_agg(key, CASE value
          WHEN 'equipment_type_id' THEN to_jsonb((SELECT target_record_id::text FROM public.custom_object_relationship
            WHERE tenant_id=equipment.tenant_id AND source_record_id=equipment.id AND archived_at IS NULL
              AND relationship_definition_id=(cfg->'relationship_ids'->>'equipment_type')::uuid))
          WHEN 'model_id' THEN to_jsonb((SELECT target_record_id::text FROM public.custom_object_relationship
            WHERE tenant_id=equipment.tenant_id AND source_record_id=equipment.id AND archived_at IS NULL
              AND relationship_definition_id=(cfg->'relationship_ids'->>'equipment_model')::uuid))
          WHEN 'year_installed' THEN to_jsonb(equipment.data->>value)
          WHEN 'year_decommissioned' THEN to_jsonb(equipment.data->>value)
          WHEN 'manufacturer' THEN to_jsonb(COALESCE(equipment.data->>value,(SELECT model.data->>'manufacturer'
            FROM public.custom_object_relationship me JOIN public.custom_object_record model ON model.id=me.target_record_id
            WHERE me.tenant_id=equipment.tenant_id AND me.source_record_id=equipment.id AND me.archived_at IS NULL
              AND me.relationship_definition_id=(cfg->'relationship_ids'->>'equipment_model')::uuid)))
          ELSE equipment.data->value END) FROM jsonb_each_text(cfg->'equipment_fields')),'{}'::jsonb) ORDER BY equipment.id)
        FROM public.custom_object_record equipment JOIN public.custom_object_relationship edge
          ON edge.source_record_id=equipment.id AND edge.tenant_id=equipment.tenant_id AND edge.archived_at IS NULL
        WHERE equipment.tenant_id=p_tenant_id AND equipment.archived_at IS NULL AND edge.target_record_id=p_department_id
          AND edge.relationship_definition_id=(cfg->'relationship_ids'->>'equipment_department')::uuid),'[]'::jsonb),
      '__department_current_set',jsonb_build_object('department_id',p_department_id,'version',version,
        'complete_sections',jsonb_build_array(cfg->>'workforce_container_field_id',cfg->>'equipment_container_field_id'))));
END;
$$;

CREATE OR REPLACE FUNCTION public.department_current_set_reconcile(
  p_tenant_id uuid, p_form_id uuid, p_department_id uuid, p_member_id uuid,
  p_submission_id uuid, p_expected_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cfg jsonb; form_row public.form%ROWTYPE; submission_data jsonb; submitted_department uuid;
  workforce_rows jsonb; equipment_rows jsonb; answer_digest text; current_version text;
  existing_commit public.department_current_set_commit%ROWTYPE; item jsonb; item_id uuid;
  existing_ids uuid[] := ARRAY[]::uuid[]; record_row public.custom_object_record%ROWTYPE;
  mapping_key text; mapping_value text; mapped jsonb; new_id uuid; relation record;
  type_id uuid; model_id uuid; serial_key text; installed_key text; manufacturer_key text;
  cleared_keys text[]; removed_ids uuid[]; decommission_key text; hidden_preserve_rule jsonb;
  hidden_source_key text; hidden_source_value text; result jsonb;
BEGIN
  PERFORM public.department_current_set_lock(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_department_id::text,4471));
  SELECT config INTO cfg FROM public.department_current_set_config WHERE tenant_id=p_tenant_id AND form_id=p_form_id FOR SHARE;
  SELECT * INTO form_row FROM public.form WHERE tenant_id=p_tenant_id AND id=p_form_id AND is_active FOR SHARE;
  IF cfg IS NULL OR form_row.id IS NULL OR NOT form_row.require_authentication OR NOT public.department_current_set_config_valid(cfg) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: form is unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM public.department_current_set_assert_relationship_pins(p_tenant_id,cfg);
  SELECT submission.submission_data INTO submission_data FROM public.form_submission submission
    WHERE submission.id=p_submission_id AND submission.tenant_id=p_tenant_id AND submission.form_id=p_form_id FOR SHARE;
  IF submission_data IS NULL OR jsonb_typeof(submission_data)<>'object' THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: durable submission data is unavailable' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.form_submission WHERE id=p_submission_id AND tenant_id=p_tenant_id AND form_id=p_form_id AND created_member_id=p_member_id) THEN
    RAISE EXCEPTION 'CURRENT_SET_AUTHORIZATION: submission actor does not match the signed member' USING ERRCODE='42501';
  END IF;
  answer_digest:=md5(submission_data::text);
  SELECT * INTO existing_commit FROM public.department_current_set_commit WHERE tenant_id=p_tenant_id AND form_id=p_form_id AND submission_id=p_submission_id FOR SHARE;
  IF existing_commit.submission_id IS NOT NULL THEN
    IF existing_commit.department_id<>p_department_id OR existing_commit.answer_digest<>answer_digest THEN RAISE EXCEPTION 'CURRENT_SET_CONFLICT: submission was already committed with different current-set data' USING ERRCODE='40001'; END IF;
    RETURN existing_commit.response||jsonb_build_object('status','replayed');
  END IF;
  submitted_department:=(submission_data->'__department_current_set'->>'department_id')::uuid;
  workforce_rows:=submission_data->(cfg->>'workforce_container_field_id'); equipment_rows:=submission_data->(cfg->>'equipment_container_field_id');
  IF submitted_department IS DISTINCT FROM p_department_id OR jsonb_typeof(workforce_rows)<>'array' OR jsonb_typeof(equipment_rows)<>'array'
    OR NOT ((submission_data->'__department_current_set'->'complete_sections') ? (cfg->>'workforce_container_field_id'))
    OR NOT ((submission_data->'__department_current_set'->'complete_sections') ? (cfg->>'equipment_container_field_id')) THEN
    RAISE EXCEPTION 'CURRENT_SET_INCOMPLETE: both loaded sections are required' USING ERRCODE='22023';
  END IF;
  PERFORM public.department_current_set_assert_respondent(p_tenant_id,p_department_id,p_member_id,cfg);
  current_version:=public.department_current_set_snapshot(p_tenant_id,p_form_id,p_department_id,cfg);
  IF current_version IS DISTINCT FROM p_expected_version OR (submission_data->'__department_current_set'->>'version') IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'CURRENT_SET_CONFLICT: current department data changed; reload and review it before saving' USING ERRCODE='40001';
  END IF;
  -- Direct workforce ownership: an identity hint may only retain a row whose
  -- sole active direct edge is this Department.
  FOR item IN SELECT value FROM jsonb_array_elements(workforce_rows) LOOP
    IF jsonb_typeof(item)<>'object' THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: invalid workforce row' USING ERRCODE='22023'; END IF;
    IF item ? '_row_id' AND item->>'_row_id' LIKE 'existing:%' THEN
      item_id:=substring(item->>'_row_id' from 10)::uuid;
      IF item_id=ANY(existing_ids) OR NOT EXISTS (SELECT 1 FROM public.custom_object_relationship edge
          JOIN public.custom_object_record row ON row.id=edge.source_record_id AND row.tenant_id=edge.tenant_id
            AND row.archived_at IS NULL AND row.custom_object_id=(cfg->>'workforce_row_object_id')::uuid
          WHERE edge.tenant_id=p_tenant_id AND edge.source_record_id=item_id AND edge.target_record_id=p_department_id
            AND edge.archived_at IS NULL AND edge.relationship_definition_id=(cfg->'relationship_ids'->>'workforce_department')::uuid) THEN
        RAISE EXCEPTION 'CURRENT_SET_INVALID: workforce row does not belong to this Department' USING ERRCODE='22023';
      END IF;
      IF (SELECT count(*) FROM public.custom_object_relationship WHERE tenant_id=p_tenant_id AND source_record_id=item_id
          AND archived_at IS NULL AND relationship_definition_id=(cfg->'relationship_ids'->>'workforce_department')::uuid)<>1 THEN
        RAISE EXCEPTION 'CURRENT_SET_AMBIGUOUS: workforce row has multiple current Departments' USING ERRCODE='P0001';
      END IF;
      existing_ids:=array_append(existing_ids,item_id);
    ELSE
      PERFORM public.department_current_set_assert_new_workforce_row(p_tenant_id,cfg,item);
    END IF;
  END LOOP;
  existing_ids:=ARRAY[]::uuid[];
  FOR item IN SELECT value FROM jsonb_array_elements(workforce_rows) LOOP
    mapped:='{}'::jsonb; cleared_keys:=ARRAY[]::text[];
    FOR mapping_key,mapping_value IN SELECT key,value FROM jsonb_each_text(cfg->'workforce_fields') LOOP
      IF item ? mapping_key AND COALESCE(item->>mapping_key,'')='' THEN cleared_keys:=array_append(cleared_keys,mapping_value);
      ELSIF item ? mapping_key THEN mapped:=mapped||jsonb_build_object(mapping_value,CASE WHEN mapping_value IN ('occupied_wte','vacant_wte') THEN to_jsonb((item->>mapping_key)::numeric) ELSE item->mapping_key END); END IF;
    END LOOP;
    IF item ? '_row_id' AND item->>'_row_id' LIKE 'existing:%' THEN
      item_id:=substring(item->>'_row_id' from 10)::uuid; existing_ids:=array_append(existing_ids,item_id);
      UPDATE public.custom_object_record SET data=(data||mapped)-cleared_keys,updated_at=now(),updated_by='member:'||p_member_id WHERE tenant_id=p_tenant_id AND id=item_id AND archived_at IS NULL;
    ELSE
      INSERT INTO public.custom_object_record(tenant_id,custom_object_id,data,created_by,updated_by)
        VALUES(p_tenant_id,(cfg->>'workforce_row_object_id')::uuid,mapped,'member:'||p_member_id,'member:'||p_member_id) RETURNING id INTO new_id;
      SELECT * INTO relation FROM public.custom_object_relationship_definition WHERE tenant_id=p_tenant_id AND id=(cfg->'relationship_ids'->>'workforce_department')::uuid AND status='active';
      INSERT INTO public.custom_object_relationship(tenant_id,relationship_definition_id,source_record_id,target_record_id,created_by)
        VALUES(p_tenant_id,relation.id,new_id,p_department_id,'member:'||p_member_id);
      existing_ids:=array_append(existing_ids,new_id);
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(source_record_id),ARRAY[]::uuid[]) INTO removed_ids FROM public.custom_object_relationship
    WHERE tenant_id=p_tenant_id AND target_record_id=p_department_id AND archived_at IS NULL
      AND relationship_definition_id=(cfg->'relationship_ids'->>'workforce_department')::uuid AND NOT source_record_id=ANY(existing_ids);
  UPDATE public.custom_object_relationship SET archived_at=now(),archived_by='member:'||p_member_id WHERE tenant_id=p_tenant_id
    AND relationship_definition_id=(cfg->'relationship_ids'->>'workforce_department')::uuid AND source_record_id=ANY(removed_ids) AND archived_at IS NULL;
  UPDATE public.custom_object_record SET archived_at=now(),archived_by='member:'||p_member_id,archive_reason='Removed from Department current set'
    WHERE tenant_id=p_tenant_id AND id=ANY(removed_ids) AND archived_at IS NULL;

  -- Equipment is still direct and retains the v1 blank/hidden-value protocol.
  existing_ids:=ARRAY[]::uuid[];
  SELECT key INTO serial_key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value='serial_number';
  SELECT key INTO installed_key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value='year_installed';
  SELECT key INTO manufacturer_key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value='manufacturer';
  SELECT key INTO decommission_key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value='year_decommissioned';
  hidden_preserve_rule:=cfg->'equipment_hidden_preserve'->decommission_key; hidden_source_key:=hidden_preserve_rule->>'source_field_id'; hidden_source_value:=hidden_preserve_rule->>'value';
  FOR item IN SELECT value FROM jsonb_array_elements(equipment_rows) LOOP
    IF jsonb_typeof(item)<>'object' THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: invalid equipment row' USING ERRCODE='22023'; END IF;
    IF item ? '_row_id' AND item->>'_row_id' LIKE 'existing:%' THEN
      item_id:=substring(item->>'_row_id' from 10)::uuid;
      IF item_id=ANY(existing_ids) OR NOT EXISTS (SELECT 1 FROM public.custom_object_relationship edge JOIN public.custom_object_record e ON e.id=edge.source_record_id AND e.tenant_id=edge.tenant_id AND e.archived_at IS NULL AND e.custom_object_id=(cfg->>'equipment_object_id')::uuid WHERE edge.tenant_id=p_tenant_id AND edge.source_record_id=item_id AND edge.target_record_id=p_department_id AND edge.archived_at IS NULL AND edge.relationship_definition_id=(cfg->'relationship_ids'->>'equipment_department')::uuid) THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: equipment row does not belong to this Department' USING ERRCODE='22023'; END IF;
      IF (SELECT count(*) FROM public.custom_object_relationship WHERE tenant_id=p_tenant_id AND source_record_id=item_id AND archived_at IS NULL AND relationship_definition_id=(cfg->'relationship_ids'->>'equipment_department')::uuid)<>1 THEN RAISE EXCEPTION 'CURRENT_SET_AMBIGUOUS: equipment record has multiple current Departments' USING ERRCODE='P0001'; END IF;
      SELECT * INTO record_row FROM public.custom_object_record WHERE tenant_id=p_tenant_id AND id=item_id AND archived_at IS NULL FOR SHARE;
      IF COALESCE(record_row.data->>'serial_number','')<>'' AND COALESCE(item->>serial_key,'')='' THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: an existing serial number cannot be cleared' USING ERRCODE='22023'; END IF;
      IF COALESCE(record_row.data->>'year_installed','')<>'' AND COALESCE(item->>installed_key,'')='' THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: an existing installation year cannot be cleared' USING ERRCODE='22023'; END IF;
      existing_ids:=array_append(existing_ids,item_id);
    ELSIF COALESCE(item->>serial_key,'')='' OR COALESCE(item->>installed_key,'') !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: new equipment requires serial number and a whole installation year' USING ERRCODE='22023'; END IF;
    IF item ? installed_key AND COALESCE(item->>installed_key,'')<>'' AND item->>installed_key !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: installation year must be a whole year' USING ERRCODE='22023'; END IF;
    IF item->>hidden_source_key=hidden_source_value AND item ? decommission_key AND COALESCE(item->>decommission_key,'')<>'' AND item->>decommission_key !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: decommissioning year must be a whole year' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(equipment_rows) LOOP
    type_id:=NULLIF(item->>(SELECT key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value='equipment_type_id'),'')::uuid; model_id:=NULLIF(item->>(SELECT key FROM jsonb_each_text(cfg->'equipment_fields') WHERE value='model_id'),'')::uuid;
    SELECT * INTO relation FROM public.custom_object_relationship_definition WHERE tenant_id=p_tenant_id AND id=(cfg->'relationship_ids'->>'equipment_type')::uuid AND status='active' FOR SHARE;
    IF relation.id IS NULL OR type_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.custom_object_record WHERE tenant_id=p_tenant_id AND id=type_id AND custom_object_id=relation.target_custom_object_id AND archived_at IS NULL) THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: equipment Type is not an active catalogue record' USING ERRCODE='22023'; END IF;
    IF model_id IS NOT NULL THEN
      SELECT * INTO relation FROM public.custom_object_relationship_definition WHERE tenant_id=p_tenant_id AND id=(cfg->'relationship_ids'->>'equipment_model')::uuid AND status='active' FOR SHARE;
      IF relation.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.custom_object_record model WHERE model.tenant_id=p_tenant_id AND model.id=model_id AND model.custom_object_id=relation.target_custom_object_id AND model.archived_at IS NULL AND model.data->>'manufacturer'=item->>manufacturer_key) OR NOT EXISTS(SELECT 1 FROM public.custom_object_relationship mt WHERE mt.tenant_id=p_tenant_id AND mt.source_record_id=model_id AND mt.target_record_id=type_id AND mt.archived_at IS NULL AND mt.relationship_definition_id=(cfg->'relationship_ids'->>'model_type')::uuid) THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: Model does not match Type and Manufacturer' USING ERRCODE='22023'; END IF;
    ELSIF COALESCE(item->>manufacturer_key,'')<>'' AND NOT EXISTS(SELECT 1 FROM public.custom_object_record model WHERE model.tenant_id=p_tenant_id AND model.archived_at IS NULL AND model.data->>'manufacturer'=item->>manufacturer_key AND EXISTS(SELECT 1 FROM public.custom_object_relationship mt WHERE mt.tenant_id=p_tenant_id AND mt.source_record_id=model.id AND mt.target_record_id=type_id AND mt.archived_at IS NULL AND mt.relationship_definition_id=(cfg->'relationship_ids'->>'model_type')::uuid)) THEN RAISE EXCEPTION 'CURRENT_SET_INVALID: Manufacturer is not available for the selected Type' USING ERRCODE='22023'; END IF;
    mapped:='{}'::jsonb; cleared_keys:=ARRAY[]::text[];
    FOR mapping_key,mapping_value IN SELECT key,value FROM jsonb_each_text(cfg->'equipment_fields') LOOP
      IF mapping_value NOT IN ('equipment_type_id','model_id') AND item ? mapping_key THEN
        IF mapping_key=decommission_key AND item->>hidden_source_key IS DISTINCT FROM hidden_source_value THEN CONTINUE;
        ELSIF COALESCE(item->>mapping_key,'')='' THEN cleared_keys:=array_append(cleared_keys,mapping_value);
        ELSE mapped:=mapped||jsonb_build_object(mapping_value,CASE WHEN mapping_value IN ('year_installed','year_decommissioned') THEN to_jsonb((item->>mapping_key)::numeric) ELSE item->mapping_key END); END IF;
      END IF;
    END LOOP;
    IF item ? '_row_id' AND item->>'_row_id' LIKE 'existing:%' THEN item_id:=substring(item->>'_row_id' from 10)::uuid; existing_ids:=array_append(existing_ids,item_id); UPDATE public.custom_object_record SET data=(data||mapped)-cleared_keys,updated_at=now(),updated_by='member:'||p_member_id WHERE tenant_id=p_tenant_id AND id=item_id AND archived_at IS NULL;
    ELSE INSERT INTO public.custom_object_record(tenant_id,custom_object_id,data,created_by,updated_by) VALUES(p_tenant_id,(cfg->>'equipment_object_id')::uuid,mapped,'member:'||p_member_id,'member:'||p_member_id) RETURNING id INTO item_id; SELECT * INTO relation FROM public.custom_object_relationship_definition WHERE tenant_id=p_tenant_id AND id=(cfg->'relationship_ids'->>'equipment_department')::uuid AND status='active'; INSERT INTO public.custom_object_relationship(tenant_id,relationship_definition_id,source_record_id,target_record_id,created_by) VALUES(p_tenant_id,relation.id,item_id,p_department_id,'member:'||p_member_id); existing_ids:=array_append(existing_ids,item_id); END IF;
    FOR relation IN SELECT * FROM public.custom_object_relationship_definition WHERE tenant_id=p_tenant_id AND status='active' AND id IN ((cfg->'relationship_ids'->>'equipment_type')::uuid,(cfg->'relationship_ids'->>'equipment_model')::uuid) LOOP
      UPDATE public.custom_object_relationship SET archived_at=now(),archived_by='member:'||p_member_id WHERE tenant_id=p_tenant_id AND source_record_id=item_id AND relationship_definition_id=relation.id AND archived_at IS NULL AND (relation.id<>(cfg->'relationship_ids'->>'equipment_type')::uuid OR target_record_id<>type_id) AND (relation.id<>(cfg->'relationship_ids'->>'equipment_model')::uuid OR model_id IS NULL OR target_record_id<>model_id);
      IF relation.id=(cfg->'relationship_ids'->>'equipment_type')::uuid OR (relation.id=(cfg->'relationship_ids'->>'equipment_model')::uuid AND model_id IS NOT NULL) THEN INSERT INTO public.custom_object_relationship(tenant_id,relationship_definition_id,source_record_id,target_record_id,created_by) SELECT p_tenant_id,relation.id,item_id,CASE WHEN relation.id=(cfg->'relationship_ids'->>'equipment_type')::uuid THEN type_id ELSE model_id END,'member:'||p_member_id WHERE NOT EXISTS(SELECT 1 FROM public.custom_object_relationship ce WHERE ce.tenant_id=p_tenant_id AND ce.relationship_definition_id=relation.id AND ce.source_record_id=item_id AND ce.target_record_id=CASE WHEN relation.id=(cfg->'relationship_ids'->>'equipment_type')::uuid THEN type_id ELSE model_id END AND ce.archived_at IS NULL); END IF;
    END LOOP;
  END LOOP;
  SELECT COALESCE(array_agg(source_record_id),ARRAY[]::uuid[]) INTO removed_ids FROM public.custom_object_relationship WHERE tenant_id=p_tenant_id AND target_record_id=p_department_id AND archived_at IS NULL AND relationship_definition_id=(cfg->'relationship_ids'->>'equipment_department')::uuid AND NOT source_record_id=ANY(existing_ids);
  UPDATE public.custom_object_relationship SET archived_at=now(),archived_by='member:'||p_member_id WHERE tenant_id=p_tenant_id AND source_record_id=ANY(removed_ids) AND archived_at IS NULL AND relationship_definition_id IN ((cfg->'relationship_ids'->>'equipment_department')::uuid,(cfg->'relationship_ids'->>'equipment_type')::uuid,(cfg->'relationship_ids'->>'equipment_model')::uuid);
  UPDATE public.custom_object_record SET archived_at=now(),archived_by='member:'||p_member_id,archive_reason='Removed from Department current set' WHERE tenant_id=p_tenant_id AND id=ANY(removed_ids) AND archived_at IS NULL;
  result:=public.department_current_set_load(p_tenant_id,p_form_id,p_department_id,p_member_id)||jsonb_build_object('status','committed');
  INSERT INTO public.department_current_set_commit(tenant_id,form_id,department_id,submission_id,answer_digest,response) VALUES(p_tenant_id,p_form_id,p_department_id,p_submission_id,answer_digest,result);
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.department_current_set_assert_new_workforce_row(uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_load(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.department_current_set_load(uuid, uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.department_current_set_reconcile(uuid, uuid, uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.department_current_set_reconcile(uuid, uuid, uuid, uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';