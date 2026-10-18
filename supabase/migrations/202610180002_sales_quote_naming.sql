-- Task 5150: schema BEFORE code. Requires 202610180001 (catalogue visibility).
-- Forward-only: no document, task/list, identifier, or tenant data is renamed.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- ECMAScript String.trim whitespace, so SQL and API agree, including Unicode.
ALTER TABLE public.sales_settings
 ADD COLUMN IF NOT EXISTS quote_singular_name text NOT NULL DEFAULT 'Quote',
 ADD COLUMN IF NOT EXISTS quote_plural_name text NOT NULL DEFAULT 'Quotes',
 ADD COLUMN IF NOT EXISTS quote_url_segment text NOT NULL DEFAULT 'quotes';

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sales_settings'::regclass AND conname='sales_settings_quote_singular_name_check') THEN
  ALTER TABLE public.sales_settings ADD CONSTRAINT sales_settings_quote_singular_name_check CHECK (
   char_length(quote_singular_name) BETWEEN 1 AND 100 AND
   quote_singular_name=btrim(quote_singular_name,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sales_settings'::regclass AND conname='sales_settings_quote_plural_name_check') THEN
  ALTER TABLE public.sales_settings ADD CONSTRAINT sales_settings_quote_plural_name_check CHECK (
   char_length(quote_plural_name) BETWEEN 1 AND 100 AND
   quote_plural_name=btrim(quote_plural_name,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sales_settings'::regclass AND conname='sales_settings_quote_url_segment_check') THEN
  ALTER TABLE public.sales_settings ADD CONSTRAINT sales_settings_quote_url_segment_check CHECK (
   char_length(quote_url_segment) BETWEEN 1 AND 100
   AND quote_url_segment COLLATE "C" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
   AND quote_url_segment NOT IN ('dashboard','pipeline','opportunities','catalogue','reports','settings','allocations','products','bundles','tasks'));
 END IF;
END $$;

-- Extend the latest installed RPC, preserving the visibility implementation
-- byte-for-byte, including strict JSON boolean handling and explicit false.
-- Do not replace it with the older task-list-only function.
DO $migration$
DECLARE
 definition text;
 validation_anchor text := 'INSERT INTO public.sales_settings(tenant_id)';
 update_anchor text := 'UPDATE public.sales_settings SET';
BEGIN
 SELECT pg_get_functiondef('public.patch_sales_settings(uuid,integer,jsonb,text,text)'::regprocedure)
 INTO definition;
 IF position('quote_naming_v1' IN definition) = 0 THEN
  IF position(validation_anchor IN definition) = 0
    OR position(update_anchor IN definition) = 0
    OR position('catalogue_visibility_v1' IN definition) = 0
    OR position('show_internal_code=CASE' IN definition) = 0
    OR position('show_sku=CASE' IN definition) = 0
    OR position('quote_task_list_name=CASE' IN definition) = 0
    OR position('FOR UPDATE' IN definition) = 0
    OR position('40001' IN definition) = 0
    OR position('ON CONFLICT' IN definition) = 0
    OR position('sales_audit_event' IN definition) = 0 THEN
   RAISE EXCEPTION 'Review the installed catalogue visibility settings RPC before extending quote naming';
  END IF;
  definition := replace(definition, validation_anchor, $validation$
 -- quote_naming_v1: labels count Unicode codepoints after ECMAScript-compatible trimming.
 IF (p_patch ? 'quoteSingularName' AND (
  jsonb_typeof(p_patch->'quoteSingularName') IS DISTINCT FROM 'string'
  OR char_length(btrim(p_patch->>'quoteSingularName',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) NOT BETWEEN 1 AND 100))
  OR (p_patch ? 'quotePluralName' AND (
  jsonb_typeof(p_patch->'quotePluralName') IS DISTINCT FROM 'string'
  OR char_length(btrim(p_patch->>'quotePluralName',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) NOT BETWEEN 1 AND 100)) THEN
  RAISE EXCEPTION 'Quote names must contain 1-100 characters' USING ERRCODE='22023';
 END IF;
 IF p_patch ? 'quoteUrlSegment' AND (
  jsonb_typeof(p_patch->'quoteUrlSegment') IS DISTINCT FROM 'string'
  OR char_length(p_patch->>'quoteUrlSegment') NOT BETWEEN 1 AND 100
  OR (p_patch->>'quoteUrlSegment') COLLATE "C" !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  OR p_patch->>'quoteUrlSegment' IN ('dashboard','pipeline','opportunities','catalogue','reports','settings','allocations','products','bundles','tasks')) THEN
  RAISE EXCEPTION 'quoteUrlSegment must be a non-reserved lowercase ASCII slug of 1-100 characters' USING ERRCODE='22023';
 END IF;
 INSERT INTO public.sales_settings(tenant_id)$validation$);
  definition := replace(definition, update_anchor, $update$
 UPDATE public.sales_settings SET
  quote_singular_name=CASE WHEN p_patch ? 'quoteSingularName' THEN btrim(p_patch->>'quoteSingularName',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') ELSE quote_singular_name END,
  quote_plural_name=CASE WHEN p_patch ? 'quotePluralName' THEN btrim(p_patch->>'quotePluralName',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') ELSE quote_plural_name END,
  quote_url_segment=CASE WHEN p_patch ? 'quoteUrlSegment' THEN p_patch->>'quoteUrlSegment' ELSE quote_url_segment END,$update$);
  EXECUTE definition;
 END IF;
END $migration$;
REVOKE ALL ON FUNCTION public.patch_sales_settings(uuid,integer,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.patch_sales_settings(uuid,integer,jsonb,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
