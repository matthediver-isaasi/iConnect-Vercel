-- Organisation-group rules use primary organisation group, else direct member
-- group. Queue once per changed tenant per statement and fence running workers.
CREATE OR REPLACE FUNCTION public.trg_queue_auto_memberships_from_group_sources()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tenants uuid[]; watched text[];
BEGIN
  watched := CASE TG_TABLE_NAME
    WHEN 'member' THEN ARRAY['id','tenant_id','organization_id','organization_group_id','email']
    WHEN 'organization' THEN ARRAY['id','tenant_id','organization_group_id']
    WHEN 'organization_group' THEN ARRAY['id','tenant_id','name']
    WHEN 'preference_field' THEN ARRAY['id','tenant_id','entity_scope','is_active','field_type','options']
    ELSE ARRAY['id','tenant_id','organization_group_id','field_id','value'] END;
  IF TG_OP='UPDATE' THEN
    WITH paired AS (
      SELECT to_jsonb(o) AS prior_value, to_jsonb(n) AS next_value
      FROM old_rows o FULL JOIN new_rows n ON n.id=o.id
    ), changed AS (
      SELECT * FROM paired p
      WHERE (TG_TABLE_NAME<>'preference_field'
        OR p.prior_value->>'entity_scope'='organization_group' OR p.next_value->>'entity_scope'='organization_group')
      AND EXISTS (SELECT 1 FROM unnest(watched) k WHERE p.prior_value->k IS DISTINCT FROM p.next_value->k)
    ), ids AS (
      SELECT (prior_value->>'tenant_id')::uuid id FROM changed
      UNION SELECT (next_value->>'tenant_id')::uuid FROM changed
    ) SELECT array_agg(DISTINCT id) FILTER(WHERE id IS NOT NULL) INTO tenants FROM ids;
  ELSIF TG_OP='INSERT' THEN
    SELECT array_agg(DISTINCT tenant_id) INTO tenants FROM new_rows n
    WHERE TG_TABLE_NAME<>'preference_field' OR to_jsonb(n)->>'entity_scope'='organization_group';
  ELSE
    SELECT array_agg(DISTINCT tenant_id) INTO tenants FROM old_rows o
    WHERE TG_TABLE_NAME<>'preference_field' OR to_jsonb(o)->>'entity_scope'='organization_group';
  END IF;
  IF coalesce(cardinality(tenants),0)=0 THEN RETURN NULL; END IF;
  UPDATE public.member_group mg SET
    automatic_membership_sync_status='queued',
    automatic_membership_cursor=NULL,
    automatic_membership_sync_error=NULL,
    automatic_membership_generation=mg.automatic_membership_generation+1
  WHERE mg.tenant_id=ANY(tenants) AND mg.automatic_membership_enabled IS TRUE
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(mg.automatic_membership_filter_groups)='array'
          THEN mg.automatic_membership_filter_groups ELSE '[]'::jsonb END) fg
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(fg->'conditions')='array'
          THEN fg->'conditions' ELSE '[]'::jsonb END) cond
      WHERE cond->>'entity_scope'='organization_group'
    );
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.trg_queue_auto_memberships_from_group_sources() FROM PUBLIC,anon,authenticated;

-- Existing insert/delete member and organisation triggers already queue all
-- scopes; only their association updates need an additional trigger.
DROP TRIGGER IF EXISTS trg_member_group_source_queue_update ON public.member;
CREATE TRIGGER trg_member_group_source_queue_update AFTER UPDATE ON public.member
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_group_sources();
DROP TRIGGER IF EXISTS trg_org_group_source_queue_update ON public.organization;
CREATE TRIGGER trg_org_group_source_queue_update AFTER UPDATE ON public.organization
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_group_sources();

DO $$
DECLARE tab text; op text; trigger_name text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['organization_group','organization_group_preference_value','preference_field'] LOOP
    FOREACH op IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
      trigger_name := 'trg_auto_group_source_' || lower(op);
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',trigger_name,tab);
      EXECUTE format('CREATE TRIGGER %I AFTER %s ON public.%I REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION public.trg_queue_auto_memberships_from_group_sources()',
        trigger_name,op,tab,CASE op WHEN 'INSERT' THEN 'NEW TABLE AS new_rows'
          WHEN 'DELETE' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END);
    END LOOP;
  END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
