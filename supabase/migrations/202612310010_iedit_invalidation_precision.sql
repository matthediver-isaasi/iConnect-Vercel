-- Additive to 007. No backfill, activation, claims, publication or settings changes.
-- Audit: memberContentIEditGeneration.js reads page identity/title/slug/status/
-- layout/builder/microsite and element identity/order/content/settings. Keep all.
-- memberContentIEditDynamic.js reads member first_name/last_name for bylines,
-- organization name/logo_url for directory names/eligibility, card_deck content/
-- status and Wall of Fame content/activity/parents/order. Access helpers also
-- consume member identity/email/roles/groups and policy data: NOT ignored.
-- Unknown columns, tables, setting keys and element types always stay broad.
BEGIN;

DO $patch$
DECLARE
  target regprocedure := to_regprocedure('public.iedit_member_content_change()');
  definition text;
  original_hash text := 'f544251efd883ab9113865f80cf8b685';
  patched_hash text := 'dc3a6c04d4fb55992708ac0e1ab7a2c8';
  old_declare text := '  parent_tenants uuid[];';
  new_declare text := $declare$  parent_tenants uuid[];
  changed_keys text[];
  ignored_keys text[] := ARRAY['updated_at'];
  audited_keys text[];
  dependent_types text[];
  known_types constant text[] := ARRAY[
    'hero','text_block','image','two_column','cta_button','image_hero',
    'wall_of_fame','form','text_overlay_image','table','banner_carousel',
    'showcase','resources_showcase','button_block','page_header_hero',
    'organisation_directory','featured_job','image_panel','accordion','quote',
    'fifty_fifty','card_deck','logo_grid','event_spotlight','video','timeline',
    'hero_carousel','gallery'];$declare$;
  old_begin text := E'BEGIN\n  IF TG_NARGS = 2 THEN';
  new_begin text := $begin$BEGIN
  -- Compare changed keys, not a projection allowlist: a future column addition
  -- cannot silently become irrelevant. INSERT/DELETE retain 007's broad path.
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(key ORDER BY key) INTO changed_keys
    FROM (
      SELECT key FROM jsonb_object_keys(before_row || after_row) keys(key)
      WHERE before_row->key IS DISTINCT FROM after_row->key
    ) changed;
    IF changed_keys IS NULL THEN RETURN NEW; END IF;
    -- Timestamp-only writes are proven irrelevant only on the audited tables.
    -- last_login is operational, not a member policy or byline input.
    IF TG_TABLE_NAME = 'member' THEN
      ignored_keys := ignored_keys || ARRAY['last_login'];
    END IF;
    IF TG_TABLE_NAME IN (
      'i_edit_page','i_edit_page_element','wall_of_fame_section',
      'wall_of_fame_category','wall_of_fame_person','resource','news_post',
      'blog_post','event','complex_event','job_posting','gallery','gallery_photo',
      'organization','organization_group','organization_preference_value',
      'preference_field','form','card_deck','speaker','role','blog_post_author',
      'member','guest_writer','survey_version','event_survey_assignment',
      'form_survey_published','event_speaker','resource_category',
      'member_resource_category','news_category','blog_category','event_category',
      'job_category','communication_category','communication_category_role',
      'tenant','system_settings','microsite'
    ) AND changed_keys <@ ignored_keys THEN RETURN NEW; END IF;

    -- Only these complete, audited changed-field sets permit page narrowing.
    -- Do not use saved chunk dependencies: newly eligible/removed records may
    -- have no provenance. Select ALL elements of the relevant renderer type.
    CASE TG_TABLE_NAME
      WHEN 'member' THEN
        audited_keys := ARRAY['first_name','last_name'];
        dependent_types := ARRAY['showcase'];
      WHEN 'guest_writer' THEN
        audited_keys := ARRAY['full_name'];
        dependent_types := ARRAY['showcase'];
      WHEN 'organization' THEN
        audited_keys := ARRAY['name','logo_url'];
        dependent_types := ARRAY['organisation_directory'];
      WHEN 'wall_of_fame_section' THEN
        audited_keys := ARRAY['name','is_active'];
        dependent_types := ARRAY['wall_of_fame'];
      WHEN 'wall_of_fame_category' THEN
        audited_keys := ARRAY['name','description','section_id','is_active','display_order'];
        dependent_types := ARRAY['wall_of_fame'];
      WHEN 'wall_of_fame_person' THEN
        audited_keys := ARRAY['first_name','last_name','job_title','secondary_job_title',
          'secondary_organisation','biography','is_active','category_id','display_order'];
        dependent_types := ARRAY['wall_of_fame'];
      WHEN 'card_deck' THEN
        audited_keys := ARRAY['title','description','links','target_url','button_text','status'];
        dependent_types := ARRAY['card_deck'];
      WHEN 'system_settings' THEN
        -- A key move is safe only when BOTH identities are understood.
        IF before_row->>'setting_key' IN (
          'article_display_name','org_directory_excluded_orgs',
          'org_directory_show_name_tooltip','org_directory_show_title',
          'org_directory_allowed_application_statuses','org_directory_visible_org_types'
        ) AND after_row->>'setting_key' IN (
          'article_display_name','org_directory_excluded_orgs',
          'org_directory_show_name_tooltip','org_directory_show_title',
          'org_directory_allowed_application_statuses','org_directory_visible_org_types'
        ) THEN
          audited_keys := ARRAY['setting_key','setting_value'];
          dependent_types := ARRAY['showcase','organisation_directory'];
        END IF;
      ELSE NULL;
    END CASE;
    -- Identity moves and every unaudited changed field take the original path.
    IF audited_keys IS NULL OR NOT changed_keys <@ (audited_keys || ignored_keys) THEN
      dependent_types := NULL;
    END IF;
  END IF;
  IF TG_NARGS = 2 THEN$begin$;
  old_filter text := E'WHERE p.builder_type=''iedit''\n        AND (p.tenant_id';
  new_filter text := $filter$WHERE p.builder_type='iedit'
        AND (dependent_types IS NULL OR EXISTS (
          SELECT 1 FROM public.i_edit_page_element e
          WHERE e.page_id=p.id
            -- No tenant predicate here: malformed/foreign element ownership
            -- must not make dependency discovery falsely complete.
            AND (e.element_type IS NULL OR NOT e.element_type = ANY(known_types)
              OR e.element_type = ANY(dependent_types))
        ))
        AND (p.tenant_id$filter$;
BEGIN
  IF target IS NULL THEN RAISE EXCEPTION '007 iEdit trigger function required'; END IF;
  definition := pg_get_functiondef(target);
  IF md5(definition) = patched_hash THEN RETURN; END IF;
  IF md5(definition) <> original_hash THEN
    RAISE EXCEPTION 'Exact iEdit invalidation function guard failed; inspect destination drift';
  END IF;
  IF position(old_declare IN definition)=0 OR position(old_begin IN definition)=0
    OR position(old_filter IN definition)=0 THEN
    RAISE EXCEPTION 'iEdit invalidation anchors missing';
  END IF;
  definition := replace(replace(replace(definition,
    old_declare,new_declare),old_begin,new_begin),old_filter,new_filter);
  EXECUTE definition;
END;
$patch$;
-- CREATE OR REPLACE preserves the trigger identity, timing, arguments and ACL.
-- Keep the trigger entry point non-callable even by the worker.
REVOKE ALL ON FUNCTION public.iedit_member_content_change()
  FROM PUBLIC, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
