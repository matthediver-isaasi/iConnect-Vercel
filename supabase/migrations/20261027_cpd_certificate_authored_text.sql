-- Authored content is configuration, never sample/default certificate evidence.
BEGIN;
ALTER TABLE public.cpd_certificate_placeholder
  ADD COLUMN IF NOT EXISTS text_template TEXT;

-- Preserve the existing atomic save and its version/tenant/lifecycle guards.
-- Patch only its explicit recordset projection to include the new column.
DO $migration$
DECLARE
  definition TEXT;
BEGIN
  SELECT pg_get_functiondef('public.save_cpd_certificate_template(uuid,uuid,integer,text,text,jsonb,text)'::regprocedure)
    INTO definition;
  IF position('field.text_template' IN definition) = 0 THEN
    IF position('sample_value, default_value, display_order' IN definition) = 0
      OR position('field.sample_value, field.default_value, field.display_order' IN definition) = 0
      OR position('sample_value TEXT,' IN definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected certificate save function; review migration before applying';
    END IF;
    definition := replace(definition, 'sample_value, default_value, display_order',
      'text_template, sample_value, default_value, display_order');
    definition := replace(definition, 'field.sample_value, field.default_value, field.display_order',
      'field.text_template, field.sample_value, field.default_value, field.display_order');
    definition := replace(definition, 'sample_value TEXT,', 'text_template TEXT, sample_value TEXT,');
    EXECUTE definition;
  END IF;
END;
$migration$;
COMMIT;
