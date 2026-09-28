-- DEST-only additive patch. Keep the deployed matcher's complete contract,
-- grants and permission predicates; add live site eligibility before ranking.
-- Existing 003-microsite-fence.sql already invalidates/enqueues on availability
-- changes. Do not replay foundational repair or knowledge migrations.
DO $patch$
DECLARE
  target regprocedure := to_regprocedure(
    'public.match_member_content_chunks(vector,uuid,integer,boolean,boolean,uuid,uuid[],uuid[],uuid[],text[],text[],uuid[],text,text[])');
  definition text;
  anchor text := 'AND c.content_type = ANY(p_allowed_content_types)';
  predicate text := $predicate$
      -- LIVE_MICROSITE_KNOWLEDGE_ELIGIBILITY_V1
      AND (c.content_type <> 'canvas_page' OR EXISTS (
        SELECT 1 FROM public.i_edit_page live_page
        WHERE live_page.id = c.source_id
          AND live_page.tenant_id = c.tenant_id
          AND live_page.builder_type = 'canvas'
          AND live_page.status = 'published'
          AND (live_page.microsite_id IS NULL OR EXISTS (
            SELECT 1 FROM public.microsite live_site
            WHERE live_site.id = live_page.microsite_id
              AND live_site.tenant_id = c.tenant_id
              AND live_site.is_active IS TRUE
          ))
      ))
$predicate$;
BEGIN
  IF target IS NULL THEN RAISE EXCEPTION 'Knowledge matcher is not installed'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.microsite'::regclass
      AND tgname = 'microsite_member_content_change'
      AND tgenabled IN ('O', 'A')
  ) THEN RAISE EXCEPTION 'Active microsite generation invalidation trigger required'; END IF;
  definition := pg_get_functiondef(target);
  IF position('LIVE_MICROSITE_KNOWLEDGE_ELIGIBILITY_V1' IN definition) > 0 THEN RETURN; END IF;
  IF position(anchor IN definition) = 0 OR
     position(anchor IN substring(definition FROM position(anchor IN definition) + length(anchor))) > 0
  THEN RAISE EXCEPTION 'Unexpected deployed matcher; refusing to patch'; END IF;
  EXECUTE replace(definition, anchor, anchor || predicate);
END;
$patch$;