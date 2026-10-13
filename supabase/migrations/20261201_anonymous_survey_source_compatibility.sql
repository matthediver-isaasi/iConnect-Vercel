-- `source` is accepted by the deployed anonymous submission caller, but is
-- not a form_submission column. Remove only that attribute after the existing
-- input allowlist check, before passing the payload to the nested insert RPC.
-- Preserve publication, tenant, identity, dedupe, retry and permission checks.
DO $migration$
DECLARE
  definition text := pg_get_functiondef(
    'public.accept_anonymous_survey_completion(jsonb,jsonb,uuid,text,text)'::regprocedure
  );
  old_payload text := 'v_payload := p_submission || jsonb_build_object(''is_anonymous'',true,';
  new_payload text := 'v_payload := (p_submission - ''source'') || jsonb_build_object(''is_anonymous'',true,';
BEGIN
  IF position(new_payload IN definition) > 0 THEN RETURN; END IF;
  IF position(old_payload IN definition) = 0
    OR (length(definition) - length(replace(definition, old_payload, '')))
       <> length(old_payload) THEN
    RAISE EXCEPTION 'Unexpected anonymous survey payload construction; review before applying';
  END IF;
  EXECUTE replace(definition, old_payload, new_payload);
END;
$migration$;
