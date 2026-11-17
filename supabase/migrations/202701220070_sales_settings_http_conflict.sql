BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Preserve the installed settings implementation and ACL. Do not replace other
-- serialization failures, or replay older settings definitions over new fields.
DO $migration$
DECLARE
  target oid := to_regprocedure('public.patch_sales_settings(uuid,integer,jsonb,text,text)');
  definition text;
  pattern text := $pattern$RAISE EXCEPTION 'Sales settings version conflict' USING ERRCODE='40001'$pattern$;
  replacement text := $replacement$RAISE EXCEPTION 'Sales settings version conflict' USING ERRCODE='PT409'$replacement$;
BEGIN
  IF target IS NULL THEN RAISE EXCEPTION 'Sales settings RPC is missing'; END IF;
  definition := pg_get_functiondef(target);
  IF position(replacement IN definition)>0 AND position(pattern IN definition)=0 THEN
    RETURN;
  END IF;
  IF (length(definition)-length(replace(definition,pattern,'')))/length(pattern) <> 1 THEN
    RAISE EXCEPTION 'Unexpected Sales settings conflict contract; review before applying';
  END IF;
  EXECUTE replace(definition,pattern,replacement);
END $migration$;
NOTIFY pgrst, 'reload schema';
COMMIT;
