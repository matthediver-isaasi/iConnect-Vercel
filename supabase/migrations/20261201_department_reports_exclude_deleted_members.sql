-- Preserve historical relationships, but exclude anonymised deleted members
-- from the two existing BNMS Department reports. Other report scopes retain
-- their existing semantics. Apply via the pinned runner, which verifies both
-- report results and permissions before committing.
DO $migration$
DECLARE
  signature text;
  definition text;
  needle text;
  replacement text;
  body_hash text;
BEGIN
  signature := 'public.custom_object_report_occurrence_page(uuid,uuid,uuid,text,text,uuid,uuid,boolean,integer,integer)';
  SELECT pg_get_functiondef(oid), md5(prosrc) INTO definition, body_hash
    FROM pg_proc WHERE oid = signature::regprocedure;
  IF position('department_reports_exclude_deleted_members' IN definition) = 0 THEN
    IF body_hash <> '06468f97d19b250761e99371c773123f' THEN
      RAISE EXCEPTION 'Department occurrence contract changed; review before applying';
    END IF;
    needle := 'AND member_endpoint.tenant_id = p_tenant_id';
    replacement := needle || $patch$
     -- department_reports_exclude_deleted_members
     AND (
       p_tenant_id IS DISTINCT FROM 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
       OR p_custom_object_id IS DISTINCT FROM 'cd1ebfd3-3e16-4091-be5a-99992d926f2f'::uuid
       OR p_relationship_definition_id IS DISTINCT FROM '0fdede92-efa2-4d84-9b16-df1a88069486'::uuid
       OR COALESCE(member_endpoint.email, '') !~* '^deleted_.+@deleted[.]local$'
     )$patch$;
    IF position(needle IN definition) = 0 THEN RAISE EXCEPTION 'Occurrence insertion point missing'; END IF;
    EXECUTE replace(definition, needle, replacement);
  END IF;

  signature := 'public.custom_object_report_distinct_counts(uuid,text,uuid,uuid[],jsonb)';
  SELECT pg_get_functiondef(oid), md5(prosrc) INTO definition, body_hash
    FROM pg_proc WHERE oid = signature::regprocedure;
  IF position('department_reports_exclude_deleted_members' IN definition) = 0 THEN
    IF body_hash <> 'bda6b83f87f02538bc0ee5eec0838128' THEN
      RAISE EXCEPTION 'Department count contract changed; review before applying';
    END IF;
    needle := $match$v_endpoint_object_id
      ) ELSE '' END,$match$;
    replacement := $patch$v_endpoint_object_id
      )
      -- department_reports_exclude_deleted_members
      WHEN v_endpoint_kind = 'member'
        AND p_tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
        AND p_start_kind = 'custom_object'
        AND p_start_custom_object_id = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f'::uuid
        AND jsonb_array_length(p_path) = 1
        AND v_definition_id = '0fdede92-efa2-4d84-9b16-df1a88069486'::uuid
      THEN 'AND COALESCE(endpoint.email, '''') !~* ''^deleted_.+@deleted[.]local$'''
      ELSE '' END,$patch$;
    IF position(needle IN definition) = 0 THEN RAISE EXCEPTION 'Count insertion point missing'; END IF;
    EXECUTE replace(definition, needle, replacement);
  END IF;
END
$migration$;

-- CREATE OR REPLACE preserves the existing service-only permissions.
NOTIFY pgrst, 'reload schema';
