BEGIN;
CREATE FUNCTION public.awards_validate_display_snapshot(p_form jsonb,p_display jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item record; field jsonb; cell record; key jsonb; config jsonb;
BEGIN
  IF p_display IS NULL OR jsonb_typeof(p_display)<>'object' OR octet_length(p_display::text)>2097152 THEN
    RAISE EXCEPTION 'Invalid review display evidence'; END IF;
  FOR item IN SELECT * FROM jsonb_each(p_display) LOOP
    SELECT f INTO field FROM jsonb_array_elements(p_form->'fields') f WHERE f->>'id'=item.key;
    IF field IS NULL OR NOT (p_form->'review_field_ids' ? item.key) OR coalesce(field->>'due_diligence','false')='true' THEN
      RAISE EXCEPTION 'Display evidence is outside the review field scope'; END IF;
    IF field->>'type' IN ('relationship_dropdown','organisation_dropdown','organisation_group_dropdown') THEN
      IF jsonb_typeof(item.value)<>'string' THEN RAISE EXCEPTION 'Invalid managed display evidence'; END IF;
    ELSIF field->>'type' IN ('repeatable_rows','repeatable_row','repeatable_grid') THEN
      IF jsonb_typeof(item.value)<>'object' THEN RAISE EXCEPTION 'Invalid row display evidence'; END IF;
      config:=coalesce(field->'repeatable_row',field);
      FOR cell IN SELECT * FROM jsonb_each(item.value) LOOP
        key:=cell.key::jsonb;
        IF jsonb_typeof(key)<>'array' OR jsonb_array_length(key)<>2 OR jsonb_typeof(cell.value)<>'string'
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(config->'children',config->'child_fields',config->'fields','[]')) child
            WHERE child->>'id'=key->>1 AND child->>'type' IN ('relationship_dropdown','organisation_dropdown','organisation_group_dropdown')
              AND coalesce(child->>'due_diligence','false')<>'true') THEN RAISE EXCEPTION 'Invalid managed row display evidence'; END IF;
      END LOOP;
    ELSE RAISE EXCEPTION 'Unsupported display evidence field'; END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.awards_validate_display_snapshot(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
