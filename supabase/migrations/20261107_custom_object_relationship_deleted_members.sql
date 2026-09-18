-- Omit anonymized members from relationship-list predicates and label/count
-- projection. Email alone is the deletion signal; NULL emails remain eligible.
-- No later migration currently overrides the 20260928 routines. Patch only
-- their member joins so scalar criteria, other endpoint kinds, validation,
-- tenant guards, ordering and paging remain byte-for-byte unchanged.
--
-- Fail closed on missing/unrecognizable routines, rather than silently leaving
-- one RPC unpatched. Reapplying accepts the already-patched join exactly once.
DO $migration$
DECLARE
  routine regprocedure;
  definition text;
  old_join text;
  new_join text;
  contract text;
BEGIN
  FOREACH contract IN ARRAY ARRAY[
    'public.custom_object_record_relationship_list(uuid,uuid,boolean,jsonb,jsonb,jsonb,integer,integer)',
    'public.custom_object_record_relationship_projection(uuid,uuid,jsonb,uuid[],integer)'
  ] LOOP
    routine := to_regprocedure(contract);
    IF routine IS NULL THEN
      RAISE EXCEPTION 'Required relationship-list routine is missing: %', contract;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc
      WHERE oid = routine AND prosecdef
        AND proconfig = ARRAY['search_path=public']::text[]
    ) THEN
      RAISE EXCEPTION 'Unexpected relationship-list security contract: %', contract;
    END IF;
    definition := pg_get_functiondef(routine);
    IF contract LIKE 'public.custom_object_record_relationship_list(%' THEN
      old_join := $join$'JOIN member ep ON ep.id = e.%I AND ep.tenant_id = $1'$join$;
      new_join := $join$'JOIN member ep ON ep.id = e.%I AND ep.tenant_id = $1 AND (ep.email IS NULL OR ep.email !~* ''^deleted_.+@deleted[.]local$'')'$join$;
    ELSE
      old_join := $join$      AND m.tenant_id = p_tenant_id
    LEFT JOIN organization o$join$;
      new_join := $join$      AND m.tenant_id = p_tenant_id
      AND (m.email IS NULL OR m.email !~* '^deleted_.+@deleted[.]local$')
    LEFT JOIN organization o$join$;
    END IF;
    IF (length(definition) - length(replace(definition, old_join, ''))) / length(old_join) = 1
       AND strpos(definition, new_join) = 0 THEN
      EXECUTE replace(definition, old_join, new_join);
    ELSIF strpos(definition, old_join) = 0
       AND (length(definition) - length(replace(definition, new_join, ''))) / length(new_join) = 1 THEN
      NULL; -- Already installed.
    ELSE
      RAISE EXCEPTION 'Unrecognized relationship-list member join: %', contract;
    END IF;
  END LOOP;
END
$migration$;

REVOKE ALL ON FUNCTION public.custom_object_record_relationship_list(uuid,uuid,boolean,jsonb,jsonb,jsonb,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_record_relationship_list(uuid,uuid,boolean,jsonb,jsonb,jsonb,integer,integer) TO service_role;
REVOKE ALL ON FUNCTION public.custom_object_record_relationship_projection(uuid,uuid,jsonb,uuid[],integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_object_record_relationship_projection(uuid,uuid,jsonb,uuid[],integer) TO service_role;

NOTIFY pgrst, 'reload schema';