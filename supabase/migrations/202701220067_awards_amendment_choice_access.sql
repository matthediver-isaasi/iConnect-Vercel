BEGIN;
CREATE FUNCTION public.awards_changed_choice_fields(p_fields jsonb,p_before jsonb,p_after jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE field jsonb; row_value jsonb; old_row jsonb; child_fields jsonb; changed jsonb:='[]'; before_value jsonb; after_value jsonb;
BEGIN
  FOR field IN SELECT value FROM jsonb_array_elements(coalesce(p_fields,'[]')) LOOP
    before_value:=CASE WHEN p_before ? (field->>'id') THEN p_before->(field->>'id') ELSE p_before->(field->>'name') END;
    after_value:=CASE WHEN p_after ? (field->>'id') THEN p_after->(field->>'id') ELSE p_after->(field->>'name') END;
    IF field->>'type' IN ('relationship_dropdown','organisation_dropdown','organisation_group_dropdown','contact','user_organization','category_dropdown','category_multiselect')
      OR field->'option_source' IS NOT NULL THEN
      IF before_value IS DISTINCT FROM after_value THEN changed:=changed||jsonb_build_array(field->>'id'); END IF;
    ELSIF field->>'type' IN ('repeatable_rows','repeatable_row','repeatable_grid') THEN
      child_fields:=coalesce(field->'repeatable_row'->'children',field->'repeatable_row'->'child_fields',
        field->'repeatable_row'->'fields',field->'children',field->'child_fields',field->'fields','[]');
      FOR row_value IN SELECT value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(after_value)='array' THEN after_value ELSE '[]' END)
      LOOP
        SELECT value INTO old_row FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(before_value)='array' THEN before_value ELSE '[]' END)
          WHERE value->>'_row_id'=row_value->>'_row_id';
        IF public.awards_changed_choice_fields(child_fields,coalesce(old_row,'{}'),row_value)<>'[]'::jsonb THEN
          changed:=changed||jsonb_build_array(field->>'id'); EXIT;
        END IF;
      END LOOP;
      -- Removing a row must not silently edit a read-only linked answer either.
      FOR old_row IN SELECT value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(before_value)='array' THEN before_value ELSE '[]' END)
      LOOP
        IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(after_value)='array' THEN after_value ELSE '[]' END)
          WHERE value->>'_row_id'=old_row->>'_row_id')
          AND public.awards_changed_choice_fields(child_fields,old_row,'{}')<>'[]'::jsonb THEN
          changed:=changed||jsonb_build_array(field->>'id'); EXIT;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN changed;
END $$;
CREATE FUNCTION public.awards_amendment_choice_changes(p_tenant uuid,p_application uuid,p_submission uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE previous public.awards_application_version; capture public.awards_intake_capture;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO previous FROM public.awards_application_version WHERE tenant_id=p_tenant AND application_id=p_application ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original evidence unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO capture FROM public.awards_intake_capture WHERE tenant_id=p_tenant AND submission_id=p_submission;
  IF NOT FOUND THEN RAISE EXCEPTION 'Amendment evidence unavailable' USING ERRCODE='42501'; END IF;
  RETURN public.awards_changed_choice_fields(previous.form_snapshot->'fields',previous.answer_snapshot,capture.answer_snapshot)
    ||public.awards_changed_choice_fields(capture.form_snapshot->'fields',previous.answer_snapshot,capture.answer_snapshot);
END $$;
REVOKE ALL ON FUNCTION public.awards_changed_choice_fields(jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_amendment_choice_changes(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_amendment_choice_changes(uuid,uuid,uuid) TO service_role;
COMMIT;
