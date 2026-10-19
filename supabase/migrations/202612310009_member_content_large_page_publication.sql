-- Increase only the page publication row bound; provider batches remain <=100,
-- and the existing 512000-byte limit and every authority/CAS check stay intact.
BEGIN;
DO $guard$
DECLARE definition text; patched text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='publish_member_content_knowledge';
  IF md5(definition)<>'5a4ba347be80fddc3f61e3fb2dae1e0e' THEN
    RAISE EXCEPTION 'Knowledge publisher changed; review large-page publication migration';
  END IF;
  patched := replace(definition,
    'OR jsonb_array_length(p_rows) > 100 THEN',
    'OR jsonb_array_length(p_rows) > (CASE WHEN p_content_type IN (''iedit_page'',''canvas_page'') THEN 2000 ELSE 100 END) THEN');
  IF patched=definition THEN RAISE EXCEPTION 'Publication bound not found'; END IF;
  EXECUTE patched;
END $guard$;
NOTIFY pgrst, 'reload schema';
COMMIT;
