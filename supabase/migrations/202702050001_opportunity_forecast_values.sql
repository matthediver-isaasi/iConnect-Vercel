-- Approved forecast separation: future conversions must preserve the manual
-- opportunity amount AND its currency. No historical values are reconstructed.
-- Patch only reviewed current functions, not historical predecessor bodies.
DO $forecast$
DECLARE
  target record;
  function_id regprocedure;
  definition text;
  replacement text;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('public.confirm_sales_quote_ticket_sale(uuid,uuid,integer,text,text,uuid)',
     'db1d00c0a9b6c434a2741308044e85e3', '69c1648ada44853fbbc051012a0469cf'),
    ('public.confirm_sales_quote_sale(uuid,uuid,integer,text,text,uuid)',
     '2f6705d6cdd598c659a7dc7673a2d170', '8245bf1098aca1a9eb8c07b02d37a2de')
  ) AS reviewed(signature, before_md5, after_md5)
  LOOP
    function_id := to_regprocedure(target.signature);
    IF function_id IS NULL THEN
      RAISE EXCEPTION 'Missing conversion prerequisite: %', target.signature;
    END IF;
    definition := pg_get_functiondef(function_id);
    IF md5(definition) = target.after_md5 THEN CONTINUE; END IF;
    IF md5(definition) <> target.before_md5 THEN
      RAISE EXCEPTION 'Unreviewed conversion function; refusing overwrite: %', target.signature;
    END IF;
    replacement := regexp_replace(definition,
      'value_minor[[:space:]]*=[[:space:]]*v[.]gross_minor,[[:space:]]*currency[[:space:]]*=[[:space:]]*v[.]currency,',
      '', 'g');
    IF md5(replacement) <> target.after_md5 THEN
      RAISE EXCEPTION 'Unexpected forecast patch: %', target.signature;
    END IF;
    EXECUTE replacement;
    IF md5(pg_get_functiondef(function_id)) <> target.after_md5 THEN
      RAISE EXCEPTION 'Forecast patch verification failed: %', target.signature;
    END IF;
  END LOOP;
END $forecast$;
