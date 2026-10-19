-- Additive to authored repair 001-005 and the service-only knowledge contract.
-- Do not replay foundations. This file does not backfill or widen tenant settings.
BEGIN;

-- Exact pg_get_functiondef fingerprints inspected read-only on pinned DEST.
-- Permit only the inspected baseline or this patch's deterministic result.
-- Whitespace/code drift requires deliberate reinspection, not fuzzy patching.
DO $guard$
DECLARE spec record; actual text;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('claim_member_content_generation(uuid,text,uuid)','979511aa51ab30addd2528d75af2160a','979511aa51ab30addd2528d75af2160a'),
    ('invalidate_member_content_source(uuid,text,uuid)','c0aa096e2f53f362f905efa5765f127c','fc8ce3cc0eb2cb771f49bdb804c6777b'),
    ('publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)','a2d831e9c2ef46702bc53889d6379005','5a4ba347be80fddc3f61e3fb2dae1e0e'),
    ('match_member_content_chunks(vector,uuid,integer,boolean,boolean,uuid,uuid[],uuid[],uuid[],text[],text[],uuid[],text,text[])','0a85dd5905590aff0e3f4754cb186047','8ed4c0248117e48037d033bfe34e28d4')
  ) expected(identity,baseline,patched)
  LOOP
    SELECT md5(pg_get_functiondef(oid)) INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||spec.identity);
    IF actual IS NULL OR actual NOT IN (spec.baseline,spec.patched) THEN
      RAISE EXCEPTION 'Exact iEdit function guard failed: %',spec.identity;
    END IF;
  END LOOP;
END;
$guard$;

-- Modify only inspected anchors; preserve deployed CAS, queue, grants and all
-- access predicates. Unknown destination contracts fail the whole transaction.
DO $patch$
DECLARE
  spec record;
  target regprocedure;
  definition text;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('invalidate_member_content_source(uuid,text,uuid)',
     '''blog_post'', ''canvas_page''',
     '''blog_post'', ''canvas_page'', ''iedit_page'''),
    ('publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)',
     'WHEN ''canvas_page'' THEN ''i_edit_page'' END',
     'WHEN ''canvas_page'' THEN ''i_edit_page'' WHEN ''iedit_page'' THEN ''i_edit_page'' END'),
    ('publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)',
     'p_content_type = ''canvas_page''', 'p_content_type IN (''canvas_page'', ''iedit_page'')'),
    ('publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)',
     'p_content_type=''canvas_page''', 'p_content_type IN (''canvas_page'',''iedit_page'')'),
    ('publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)',
     'canonical->>''builder_type''<>''canvas''',
     'canonical->>''builder_type'' IS DISTINCT FROM CASE p_content_type WHEN ''iedit_page'' THEN ''iedit'' ELSE ''canvas'' END'),
    ('publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)',
     'canonical->>''status''<>''published''',
     'canonical->>''status'' IS DISTINCT FROM ''published'''),
    ('publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)',
     '''resource_pdf'',''canvas_page'',''authored_repair''',
     '''resource_pdf'',''canvas_page'',''iedit_page'',''authored_repair'''),
    ('match_member_content_chunks(vector,uuid,integer,boolean,boolean,uuid,uuid[],uuid[],uuid[],text[],text[],uuid[],text,text[])',
     'c.content_type = ''canvas_page'' AND c.status = ''published''',
     'c.content_type IN (''canvas_page'', ''iedit_page'') AND c.status = ''published'''),
    ('match_member_content_chunks(vector,uuid,integer,boolean,boolean,uuid,uuid[],uuid[],uuid[],text[],text[],uuid[],text,text[])',
     'c.content_type <> ''canvas_page'' OR EXISTS',
     'c.content_type NOT IN (''canvas_page'', ''iedit_page'') OR EXISTS'),
    ('match_member_content_chunks(vector,uuid,integer,boolean,boolean,uuid,uuid[],uuid[],uuid[],text[],text[],uuid[],text,text[])',
     'live_page.builder_type = ''canvas''',
     'live_page.builder_type = CASE c.content_type WHEN ''iedit_page'' THEN ''iedit'' ELSE ''canvas'' END')
  ) AS changes(identity, old_text, new_text)
  LOOP
    target := to_regprocedure('public.' || spec.identity);
    IF target IS NULL THEN RAISE EXCEPTION 'Missing prerequisite %', spec.identity; END IF;
    definition := pg_get_functiondef(target);
    IF position(spec.new_text IN definition)>0 THEN CONTINUE; END IF;
    IF position(spec.old_text IN definition)=0 THEN
      RAISE EXCEPTION 'Unexpected destination contract %: missing %', spec.identity, spec.old_text;
    END IF;
    EXECUTE replace(definition, spec.old_text, spec.new_text);
  END LOOP;
  IF to_regprocedure('public.claim_member_content_generation(uuid,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Generation claim contract required';
  END IF;
END;
$patch$;

-- The generic claim RPC is type-agnostic; no new overload or activation bypass.
REVOKE ALL ON FUNCTION public.publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb),
  public.invalidate_member_content_source(uuid,text,uuid),
  public.claim_member_content_generation(uuid,text,uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.iedit_member_content_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  before_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  after_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  item record;
  parent_tenants uuid[];
BEGIN
  IF TG_NARGS = 2 THEN
    -- Parent-scoped tables have no tenant_id. Resolve both OLD and NEW parents
    -- before DELETE/FK actions; never accept tenant identity from child JSON.
    EXECUTE format('SELECT array_agg(DISTINCT tenant_id) FROM public.%I WHERE id IN ($1,$2)', TG_ARGV[0])
      INTO parent_tenants USING (before_row->>TG_ARGV[1])::uuid,(after_row->>TG_ARGV[1])::uuid;
  END IF;
  IF TG_TABLE_NAME = 'i_edit_page' THEN
    -- Include both identities on tenant/id moves and both builders on switches.
    FOR item IN
      SELECT DISTINCT (r->>'tenant_id')::uuid tenant_id, (r->>'id')::uuid id,
        CASE r->>'builder_type' WHEN 'canvas' THEN 'canvas_page' ELSE 'iedit_page' END kind
      FROM (VALUES(before_row),(after_row)) rows(r)
      WHERE r->>'builder_type' IN ('canvas','iedit')
      ORDER BY 1,3,2
    LOOP
      PERFORM public.invalidate_member_content_source(item.tenant_id,item.kind,item.id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'i_edit_page_element' THEN
    -- Parent lookup is authoritative even when elements have no tenant column.
    FOR item IN
      SELECT p.tenant_id,p.id FROM public.i_edit_page p
      WHERE p.id IN ((before_row->>'page_id')::uuid,(after_row->>'page_id')::uuid)
        AND p.builder_type='iedit' ORDER BY p.tenant_id,p.id
    LOOP
      PERFORM public.invalidate_member_content_source(item.tenant_id,'iedit_page',item.id);
    END LOOP;
  ELSE
    -- Deliberately broad invalidation includes newly eligible automatic-list
    -- entries, removed categories and old/new tenants, not just saved references.
    FOR item IN
      SELECT p.tenant_id,p.id FROM public.i_edit_page p
      WHERE p.builder_type='iedit'
        AND (p.tenant_id = ANY(parent_tenants) OR p.tenant_id IN (
          (CASE WHEN TG_TABLE_NAME='tenant' THEN before_row->>'id' ELSE before_row->>'tenant_id' END)::uuid,
          (CASE WHEN TG_TABLE_NAME='tenant' THEN after_row->>'id' ELSE after_row->>'tenant_id' END)::uuid))
      ORDER BY p.tenant_id,p.id
    LOOP
      PERFORM public.invalidate_member_content_source(item.tenant_id,'iedit_page',item.id);
    END LOOP;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.iedit_member_content_change() FROM PUBLIC,anon,authenticated,service_role;

-- Replace only the old page hook (which treated every builder as Canvas).
DROP TRIGGER IF EXISTS member_content_source_change ON public.i_edit_page;
DROP TRIGGER IF EXISTS iedit_member_content_change ON public.i_edit_page;
CREATE TRIGGER iedit_member_content_change AFTER INSERT OR UPDATE OR DELETE ON public.i_edit_page
  FOR EACH ROW EXECUTE FUNCTION public.iedit_member_content_change();
DROP TRIGGER IF EXISTS iedit_member_content_change ON public.i_edit_page_element;
CREATE TRIGGER iedit_member_content_change AFTER INSERT OR UPDATE OR DELETE ON public.i_edit_page_element
  FOR EACH ROW EXECUTE FUNCTION public.iedit_member_content_change();

DO $triggers$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'wall_of_fame_section','wall_of_fame_category','wall_of_fame_person',
    'resource','news_post','blog_post','event','complex_event','job_posting',
    'gallery','gallery_photo','organization','organization_group',
    'organization_preference_value','preference_field','form',
    'card_deck','speaker','role','blog_post_author','member','guest_writer',
    'survey_version','event_survey_assignment','form_survey_published','event_speaker',
    'resource_category','member_resource_category','news_category','blog_category',
    'event_category','job_category','communication_category','communication_category_role',
    'tenant','system_settings','microsite'
  ] LOOP
    IF to_regclass('public.' || quote_ident(name)) IS NULL THEN
      RAISE NOTICE 'Optional iEdit dependency table absent: %',name;
      CONTINUE;
    END IF;
    IF name IN ('organization_preference_value','member_resource_category') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS iedit_member_content_change ON public.%I',name);
      EXECUTE format('CREATE TRIGGER iedit_member_content_change BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.iedit_member_content_change(%L,%L)',
        name, CASE name WHEN 'organization_preference_value' THEN 'organization' ELSE 'member' END,
        CASE name WHEN 'organization_preference_value' THEN 'organization_id' ELSE 'member_id' END);
      CONTINUE;
    END IF;
    -- Never silently install an ineffective tenant hook on a parent-scoped
    -- table. Destination verification must resolve such schemas explicitly.
    IF name<>'tenant' AND NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=name AND column_name='tenant_id') THEN
      RAISE EXCEPTION 'iEdit dependency %.tenant_id missing; parent resolver required',name;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS iedit_member_content_change ON public.%I',name);
    EXECUTE format('CREATE TRIGGER iedit_member_content_change BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.iedit_member_content_change()',name);
  END LOOP;
END;
$triggers$;
-- New settings rows include both page builders. Existing tenant source
-- selections are deliberately untouched: exclusions are an operator choice.
ALTER TABLE public.member_ai_settings
  ALTER COLUMN allowed_content_types SET DEFAULT
    ARRAY['resource','event','complex_event','news_post','blog_post','canvas_page','iedit_page']::text[];
NOTIFY pgrst, 'reload schema';
COMMIT;
