BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.sales_catalogue_bundle ADD COLUMN IF NOT EXISTS tax_override jsonb;
COMMENT ON COLUMN public.sales_catalogue_bundle.tax_override IS
  'Optional validated accounting VAT identity {provider,id,name,rateBps}. Overrides component tax for new quote lines; existing quote snapshots remain unchanged.';

DO $constraint$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.sales_catalogue_bundle'::regclass
   AND conname='sales_bundle_tax_override_check') THEN
  ALTER TABLE public.sales_catalogue_bundle ADD CONSTRAINT sales_bundle_tax_override_check
   CHECK(tax_override IS NULL OR COALESCE(
     jsonb_typeof(tax_override)='object'
     AND tax_override->>'provider' IN ('xero','quickbooks')
     AND jsonb_typeof(tax_override->'id')='string' AND length(btrim(tax_override->>'id'))>0
     AND jsonb_typeof(tax_override->'name')='string' AND length(btrim(tax_override->>'name'))>0
     AND jsonb_typeof(tax_override->'rateBps')='number'
     AND (tax_override->>'rateBps')::numeric BETWEEN 0 AND 100000
     AND (tax_override->>'rateBps')::numeric=trunc((tax_override->>'rateBps')::numeric),false));
 END IF;
END $constraint$;

-- Extend installed RPCs without overwriting newer billing, membership,
-- category, ticket or exhibition protections. Unknown contracts fail closed.
DO $migration$
DECLARE definition text; anchor text;
BEGIN
 SELECT pg_get_functiondef('public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)'::regprocedure) INTO definition;
 IF position('v_bundle.tax_override' IN definition)=0 THEN
  anchor:='display_order, created_by, updated_by, billing_groups';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown bundle create columns'; END IF;
  definition:=replace(definition,anchor,anchor||', tax_override');
  anchor:='coalesce(v_bundle.billing_groups,''[]''::jsonb)';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown bundle create values'; END IF;
  EXECUTE replace(definition,anchor,anchor||', v_bundle.tax_override');
 END IF;
 SELECT pg_get_functiondef('public.update_sales_catalogue_bundle(uuid,uuid,timestamptz,jsonb,jsonb,text,text)'::regprocedure) INTO definition;
 IF position('tax_override=CASE' IN definition)=0 THEN
  anchor:='UPDATE public.sales_catalogue_bundle SET ';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown bundle update contract'; END IF;
  EXECUTE replace(definition,anchor,anchor||
    'tax_override=CASE WHEN p_record ? ''tax_override'' THEN v.tax_override ELSE old_row.tax_override END, ');
 END IF;
END $migration$;

NOTIFY pgrst,'reload schema';
COMMIT;
