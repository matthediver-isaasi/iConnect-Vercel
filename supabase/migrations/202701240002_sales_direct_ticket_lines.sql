-- Extend immutable proposal evidence, not the catalogue or public inventory.
BEGIN;
DO $migration$
DECLARE c record; definition text; patched text;
BEGIN
  SELECT conname,pg_get_constraintdef(oid) definition INTO c
  FROM pg_constraint WHERE conrelid='public.sales_quote_line'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%catalogue_kind%';
  IF c.conname IS NULL THEN RAISE EXCEPTION 'Unknown quote line identity contract'; END IF;
  EXECUTE format('ALTER TABLE public.sales_quote_line DROP CONSTRAINT %I',c.conname);
  ALTER TABLE public.sales_quote_line ADD CONSTRAINT sales_quote_line_identity CHECK (
    display_order>=0 AND quantity>0 AND (
      (catalogue_kind='product' AND catalogue_id IS NOT NULL AND product_id=catalogue_id AND bundle_id IS NULL)
      OR (catalogue_kind='bundle' AND catalogue_id IS NOT NULL AND bundle_id=catalogue_id AND product_id IS NULL)
      OR (catalogue_kind='free_text' AND catalogue_id IS NULL AND product_id IS NULL AND bundle_id IS NULL)
      OR (catalogue_kind='ticket' AND catalogue_id IS NULL AND product_id IS NULL AND bundle_id IS NULL
        AND quantity=trunc(quantity)
        AND COALESCE(catalogue_snapshot->>'event_reference_kind','') IN ('simple','complex')
        AND COALESCE(catalogue_snapshot->>'event_id','')<>''
        AND COALESCE(catalogue_snapshot->>'ticket_type_id','')<>'')
    )
  ) NOT VALID;
  -- NOT VALID retains existing historical evidence while enforcing all new writes.
  SELECT pg_get_functiondef('public.confirm_sales_quote_ticket_sale(uuid,uuid,integer,text,text,uuid)'::regprocedure)
    INTO definition;
  patched:=replace(definition,'AND l.product_id IS NOT NULL',
    'AND (l.product_id IS NOT NULL OR l.catalogue_kind=''ticket'')');
  IF patched=definition THEN RAISE EXCEPTION 'Unknown ticket allocation candidate contract'; END IF;
  EXECUTE patched;
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
