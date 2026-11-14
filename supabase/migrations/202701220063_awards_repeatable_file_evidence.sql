BEGIN;
CREATE FUNCTION public.awards_review_file_cell(p_form jsonb,p_answers jsonb,p_field text,p_cell text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE field jsonb; config jsonb; cell jsonb; rows jsonb; answer jsonb;
BEGIN
  IF NOT (p_form->'review_field_ids' ? p_field) THEN RETURN NULL; END IF;
  SELECT f INTO field FROM jsonb_array_elements(p_form->'fields') f WHERE f->>'id'=p_field;
  IF field->>'type'='file' AND p_cell='' AND coalesce(field->>'due_diligence','false')<>'true' THEN RETURN p_answers->p_field; END IF;
  IF field->>'type' NOT IN ('repeatable_rows','repeatable_row','repeatable_grid') OR coalesce(field->>'due_diligence','false')='true' THEN RETURN NULL; END IF;
  BEGIN cell:=p_cell::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END;
  IF jsonb_typeof(cell)<>'array' OR jsonb_array_length(cell)<>2 THEN RETURN NULL; END IF;
  IF jsonb_typeof(cell->0)<>'string' OR jsonb_typeof(cell->1)<>'string' THEN RETURN NULL; END IF;
  config:=coalesce(field->'repeatable_row',field);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(config->'children',config->'child_fields',config->'fields','[]')) child
    WHERE child->>'id'=cell->>1 AND child->>'type'='file' AND coalesce(child->>'due_diligence','false')<>'true') THEN RETURN NULL; END IF;
  rows:=p_answers->p_field;
  IF jsonb_typeof(rows)<>'array' THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(rows) row WHERE row->>'_row_id'=cell->>0)<>1 THEN RETURN NULL; END IF;
  SELECT row->(cell->>1) INTO answer FROM jsonb_array_elements(rows) row WHERE row->>'_row_id'=cell->>0;
  RETURN answer;
END $$;
CREATE FUNCTION public.awards_copy_amendment_cell_files(p_tenant uuid,p_application uuid,p_submission uuid,p_field text,p_cell text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE captured public.awards_intake_capture; previous public.awards_application_version; old_value jsonb; new_value jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  p_cell:=(p_cell::jsonb)::text;
  SELECT c.* INTO captured FROM public.awards_intake_capture c JOIN public.form_submission s ON s.id=c.submission_id
    JOIN public.awards_application a ON a.id=s.awards_amendment_application_id AND a.member_id IS NOT DISTINCT FROM c.member_id AND a.tenant_id=c.tenant_id
    WHERE c.tenant_id=p_tenant AND a.id=p_application AND s.id=p_submission FOR UPDATE OF c;
  IF NOT FOUND THEN RAISE EXCEPTION 'Amendment unavailable'; END IF;
  SELECT * INTO previous FROM public.awards_application_version WHERE tenant_id=p_tenant AND application_id=p_application ORDER BY revision DESC LIMIT 1;
  new_value:=public.awards_review_file_cell(captured.form_snapshot,captured.answer_snapshot,p_field,p_cell);
  old_value:=public.awards_review_file_cell(previous.form_snapshot,previous.answer_snapshot,p_field,p_cell);
  IF new_value IS NULL OR new_value IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb) OR new_value IS DISTINCT FROM old_value THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.awards_review_attachment f WHERE f.tenant_id=p_tenant AND f.field_id=p_field AND f.cell_id=p_cell
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(previous.attachment_manifest) item WHERE item->>'id'=f.id::text)) THEN
    RAISE EXCEPTION 'Original cell files unavailable; re-upload the file'; END IF;
  INSERT INTO public.awards_review_attachment(tenant_id,submission_id,field_id,cell_id,source_path,name,content,digest)
    SELECT p_tenant,p_submission,p_field,p_cell,f.source_path,f.name,f.content,f.digest FROM public.awards_review_attachment f
    WHERE f.tenant_id=p_tenant AND f.field_id=p_field AND f.cell_id=p_cell AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(previous.attachment_manifest) item WHERE item->>'id'=f.id::text)
    ON CONFLICT(submission_id,field_id,cell_id,source_path) DO NOTHING;
  RETURN true;
END $$;
CREATE FUNCTION public.awards_assert_repeatable_files_retained(p_tenant uuid,p_submission uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE captured public.awards_intake_capture; field jsonb; config jsonb; child jsonb; row jsonb; value jsonb; cell text; expected integer; retained integer;
BEGIN
  SELECT * INTO captured FROM public.awards_intake_capture WHERE tenant_id=p_tenant AND submission_id=p_submission;
  FOR field IN SELECT f FROM jsonb_array_elements(captured.form_snapshot->'fields') f
    WHERE f->>'type' IN ('repeatable_rows','repeatable_row','repeatable_grid')
      AND captured.form_snapshot->'review_field_ids' ? (f->>'id') AND coalesce(f->>'due_diligence','false')<>'true'
  LOOP
    config:=coalesce(field->'repeatable_row',field);
    FOR child IN SELECT c FROM jsonb_array_elements(coalesce(config->'children',config->'child_fields',config->'fields','[]')) c
      WHERE c->>'type'='file' AND coalesce(c->>'due_diligence','false')<>'true'
    LOOP
      FOR row IN SELECT r FROM jsonb_array_elements(coalesce(nullif(captured.answer_snapshot->(field->>'id'),'null'::jsonb),'[]')) r LOOP
        value:=row->(child->>'id');
        IF value IS NULL OR value IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb) THEN CONTINUE; END IF;
        cell:=jsonb_build_array(row->>'_row_id',child->>'id')::text;
        IF public.awards_review_file_cell(captured.form_snapshot,captured.answer_snapshot,field->>'id',cell) IS NULL THEN
          RAISE EXCEPTION 'Repeatable files require unique stable row identities'; END IF;
        expected:=1;
        IF jsonb_typeof(value)='array' THEN SELECT count(DISTINCT v) INTO expected FROM jsonb_array_elements(value) v; END IF;
        SELECT count(*) INTO retained FROM public.awards_review_attachment
          WHERE tenant_id=p_tenant AND submission_id=p_submission AND field_id=field->>'id' AND cell_id=cell;
        IF retained<>expected THEN RAISE EXCEPTION 'Repeatable review attachments have not been retained'; END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.awards_assert_repeatable_files_retained(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_review_file_cell(jsonb,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_copy_amendment_cell_files(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_copy_amendment_cell_files(uuid,uuid,uuid,text,text) TO service_role;
COMMIT;
