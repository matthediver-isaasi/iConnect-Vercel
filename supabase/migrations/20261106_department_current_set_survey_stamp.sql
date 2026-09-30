-- Stamp the Department with the UTC calendar date of every successful,
-- non-replayed current-set save. This migration changes only RPC definitions;
-- it never changes destination metadata, configuration, forms, or records.

CREATE OR REPLACE FUNCTION public.department_current_set_assert_survey_stamp_metadata(
  p_tenant_id uuid, p_form_id uuid, p_config jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
     OR p_form_id IS DISTINCT FROM '8b6f44d3-83f8-449e-9496-b10b1dc28e5f'::uuid
     OR (p_config->>'department_object_id')::uuid
        IS DISTINCT FROM 'cd1ebfd3-3e16-4091-be5a-99992d926f2f'::uuid THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: survey stamp destination pins do not match'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.custom_object_definition object_definition
    WHERE object_definition.id = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f'::uuid
      AND object_definition.tenant_id = p_tenant_id
      AND object_definition.object_key = 'org_department'
      AND object_definition.status = 'active'
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: pinned Department object is unavailable'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.preference_field field
    WHERE field.id = 'c5dcd16c-e63e-49f2-b72f-b0caaa7c5903'::uuid
      AND field.tenant_id = p_tenant_id
      AND field.name = 'survey_last_updated'
      AND field.field_type = 'date'
      AND field.is_active = true
      AND field.entity_scope = 'custom_object'
      AND field.custom_object_id = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f'::uuid
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: pinned survey date field is unavailable'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

DO $$
DECLARE
  cfg jsonb;
BEGIN
  SELECT config INTO cfg
  FROM public.department_current_set_config
  WHERE tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
    AND form_id = '8b6f44d3-83f8-449e-9496-b10b1dc28e5f'::uuid;
  IF cfg IS NULL OR NOT public.department_current_set_config_valid(cfg) THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: pinned survey configuration is unavailable'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public.department_current_set_assert_survey_stamp_metadata(
    'ff2df806-b321-4254-b651-3af11fccf1db'::uuid,
    '8b6f44d3-83f8-449e-9496-b10b1dc28e5f'::uuid,
    cfg
  );
END;
$$;

-- Complete replacement of the 20261103 core body, with the stamp added after
-- graph reconciliation and before the final snapshot and durable response.
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
  stamp_date text;
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

  PERFORM public.department_current_set_assert_survey_stamp_metadata(p_tenant_id,p_form_id,cfg);
  stamp_date:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD');
  UPDATE public.custom_object_record
    SET data=COALESCE(data,'{}'::jsonb)||jsonb_build_object('survey_last_updated',stamp_date),
        updated_at=now(),
        updated_by='member:'||p_member_id
    WHERE tenant_id=p_tenant_id
      AND id=p_department_id
      AND custom_object_id=(cfg->>'department_object_id')::uuid
      AND archived_at IS NULL;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.custom_object_record department
    WHERE department.tenant_id=p_tenant_id
      AND department.id=p_department_id
      AND department.data->>'survey_last_updated'=stamp_date
      AND department.updated_at=now()
      AND department.updated_by='member:'||p_member_id
  ) THEN
    RAISE EXCEPTION 'CURRENT_SET_INVALID: Department could not be stamped'
      USING ERRCODE='22023';
  END IF;

  result:=public.department_current_set_load(p_tenant_id,p_form_id,p_department_id,p_member_id)
    ||jsonb_build_object('status','committed');
  INSERT INTO public.department_current_set_commit(tenant_id,form_id,department_id,submission_id,answer_digest,response) VALUES(p_tenant_id,p_form_id,p_department_id,p_submission_id,answer_digest,result);
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.department_current_set_assert_survey_stamp_metadata(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.department_current_set_reconcile(uuid, uuid, uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.department_current_set_reconcile(uuid, uuid, uuid, uuid, uuid, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';