-- Queue automatic member-group reconciliation when rule source data changes.
--
-- Core records and custom preference values are observed directly with
-- statement-level transition-table triggers. Bulk imports therefore queue at
-- most once per SQL statement, not once per imported row. UPDATE triggers
-- identify the fields that actually changed and queue only enabled groups that
-- reference those rule inputs.
--
-- Every queue event increments the generation. A worker that loaded an older
-- source snapshot is then rejected by reconcile_automatic_membership instead
-- of overwriting the newly queued work.

CREATE OR REPLACE FUNCTION public.queue_automatic_memberships_for_source_changes(
  p_tenant_ids uuid[],
  p_member_core_keys text[] DEFAULT '{}'::text[],
  p_member_custom_keys text[] DEFAULT '{}'::text[],
  p_organization_core_keys text[] DEFAULT '{}'::text[],
  p_organization_custom_keys text[] DEFAULT '{}'::text[],
  p_organization_link_changed boolean DEFAULT false,
  p_match_all boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_queued integer := 0;
BEGIN
  IF COALESCE(cardinality(p_tenant_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.member_group AS mg
     SET automatic_membership_generation = mg.automatic_membership_generation + 1,
         automatic_membership_sync_status = 'queued',
         automatic_membership_cursor = NULL,
         automatic_membership_sync_error = NULL
   WHERE mg.automatic_membership_enabled = true
     AND mg.tenant_id = ANY(p_tenant_ids)
     AND (
       p_match_all
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(mg.automatic_membership_filter_groups) = 'array'
                 THEN mg.automatic_membership_filter_groups
               ELSE '[]'::jsonb
             END
           ) AS filter_group
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(filter_group->'conditions') = 'array'
                 THEN filter_group->'conditions'
               ELSE '[]'::jsonb
             END
           ) AS condition
          WHERE (
            condition->>'entity_scope' = 'member'
            AND condition->>'field_type' = 'core'
            AND condition->>'field_key' = ANY(p_member_core_keys)
          ) OR (
            condition->>'entity_scope' = 'member'
            AND condition->>'field_type' = 'custom'
            AND condition->>'field_key' = ANY(p_member_custom_keys)
          ) OR (
            condition->>'entity_scope' = 'organization'
            AND (
              p_organization_link_changed
              OR (
                condition->>'field_type' = 'core'
                AND condition->>'field_key' = ANY(p_organization_core_keys)
              )
              OR (
                condition->>'field_type' = 'custom'
                AND condition->>'field_key' = ANY(p_organization_custom_keys)
              )
            )
          )
       )
     );

  GET DIAGNOSTICS v_queued = ROW_COUNT;
  RETURN v_queued;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_automatic_memberships_for_source_changes(
  uuid[], text[], text[], text[], text[], boolean, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_automatic_memberships_for_source_changes(
  uuid[], text[], text[], text[], text[], boolean, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_queue_auto_memberships_from_new_core_rows()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT tenant_id), '{}'::uuid[])
    INTO v_tenant_ids
    FROM new_rows
   WHERE tenant_id IS NOT NULL;

  PERFORM public.queue_automatic_memberships_for_source_changes(
    p_tenant_ids => v_tenant_ids,
    p_match_all => true
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_queue_auto_memberships_from_old_core_rows()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT tenant_id), '{}'::uuid[])
    INTO v_tenant_ids
    FROM old_rows
   WHERE tenant_id IS NOT NULL;

  PERFORM public.queue_automatic_memberships_for_source_changes(
    p_tenant_ids => v_tenant_ids,
    p_match_all => true
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_queue_auto_memberships_from_member_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_ids uuid[];
  v_member_keys text[];
  v_link_changed boolean;
  v_match_all boolean;
BEGIN
  WITH paired AS (
    SELECT
      o.id AS old_id,
      n.id AS new_id,
      o.tenant_id AS old_tenant_id,
      n.tenant_id AS new_tenant_id,
      o.organization_id AS old_organization_id,
      n.organization_id AS new_organization_id,
      o.first_name AS old_first_name,
      n.first_name AS new_first_name,
      o.last_name AS old_last_name,
      n.last_name AS new_last_name,
      o.email AS old_email,
      n.email AS new_email,
      o.job_title AS old_job_title,
      n.job_title AS new_job_title,
      o.role_id AS old_role_id,
      n.role_id AS new_role_id,
      o.login_enabled AS old_login_enabled,
      n.login_enabled AS new_login_enabled,
      o.communications_opted_out_all AS old_comms,
      n.communications_opted_out_all AS new_comms
    FROM old_rows o
    FULL JOIN new_rows n ON n.id = o.id
  ),
  changed_tenants AS (
    SELECT old_tenant_id AS tenant_id FROM paired
    UNION
    SELECT new_tenant_id AS tenant_id FROM paired
  )
  SELECT
    COALESCE((
      SELECT array_agg(tenant_id) FROM changed_tenants WHERE tenant_id IS NOT NULL
    ), '{}'::uuid[]),
    COALESCE(bool_or(
      old_id IS NULL
      OR new_id IS NULL
      OR old_tenant_id IS DISTINCT FROM new_tenant_id
    ), false),
    COALESCE(bool_or(old_organization_id IS DISTINCT FROM new_organization_id), false),
    ARRAY_REMOVE(ARRAY[
      CASE WHEN bool_or(old_first_name IS DISTINCT FROM new_first_name) THEN 'first_name' END,
      CASE WHEN bool_or(old_last_name IS DISTINCT FROM new_last_name) THEN 'last_name' END,
      CASE WHEN bool_or(old_email IS DISTINCT FROM new_email) THEN 'email' END,
      CASE WHEN bool_or(old_job_title IS DISTINCT FROM new_job_title) THEN 'job_title' END,
      CASE WHEN bool_or(old_role_id IS DISTINCT FROM new_role_id) THEN 'role_id' END,
      CASE WHEN bool_or(old_login_enabled IS DISTINCT FROM new_login_enabled) THEN 'login_enabled' END,
      CASE WHEN bool_or(
        old_comms IS DISTINCT FROM new_comms
      ) THEN 'communications_opted_out_all' END
    ], NULL)
    INTO v_tenant_ids, v_match_all, v_link_changed, v_member_keys
    FROM paired;

  PERFORM public.queue_automatic_memberships_for_source_changes(
    p_tenant_ids => v_tenant_ids,
    p_member_core_keys => v_member_keys,
    p_organization_link_changed => v_link_changed,
    p_match_all => v_match_all
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_queue_auto_memberships_from_organization_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_ids uuid[];
  v_organization_keys text[];
  v_match_all boolean;
BEGIN
  WITH paired AS (
    SELECT
      o.id AS old_id,
      n.id AS new_id,
      o.tenant_id AS old_tenant_id,
      n.tenant_id AS new_tenant_id,
      o.name AS old_name,
      n.name AS new_name,
      o.status AS old_status,
      n.status AS new_status
    FROM old_rows o
    FULL JOIN new_rows n ON n.id = o.id
  ),
  changed_tenants AS (
    SELECT old_tenant_id AS tenant_id FROM paired
    UNION
    SELECT new_tenant_id AS tenant_id FROM paired
  )
  SELECT
    COALESCE((
      SELECT array_agg(tenant_id) FROM changed_tenants WHERE tenant_id IS NOT NULL
    ), '{}'::uuid[]),
    COALESCE(bool_or(
      old_id IS NULL
      OR new_id IS NULL
      OR old_tenant_id IS DISTINCT FROM new_tenant_id
    ), false),
    ARRAY_REMOVE(ARRAY[
      CASE WHEN bool_or(old_name IS DISTINCT FROM new_name) THEN 'name' END,
      CASE WHEN bool_or(old_status IS DISTINCT FROM new_status) THEN 'status' END
    ], NULL)
    INTO v_tenant_ids, v_match_all, v_organization_keys
    FROM paired;

  PERFORM public.queue_automatic_memberships_for_source_changes(
    p_tenant_ids => v_tenant_ids,
    p_organization_core_keys => v_organization_keys,
    p_match_all => v_match_all
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_queue_auto_memberships_from_member_preferences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_ids uuid[];
  v_field_keys text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT
      COALESCE(array_agg(DISTINCT m.tenant_id), '{}'::uuid[]),
      COALESCE(array_agg(DISTINCT r.field_id::text), '{}'::text[])
      INTO v_tenant_ids, v_field_keys
      FROM new_rows r
      JOIN public.member m ON m.id = r.member_id;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT
      COALESCE(array_agg(DISTINCT m.tenant_id), '{}'::uuid[]),
      COALESCE(array_agg(DISTINCT r.field_id::text), '{}'::text[])
      INTO v_tenant_ids, v_field_keys
      FROM old_rows r
      JOIN public.member m ON m.id = r.member_id;
  ELSE
    SELECT
      COALESCE(array_agg(DISTINCT tenant_id), '{}'::uuid[]),
      COALESCE(array_agg(DISTINCT field_key), '{}'::text[])
      INTO v_tenant_ids, v_field_keys
      FROM (
        SELECT m.tenant_id, r.field_id::text AS field_key
          FROM new_rows r JOIN public.member m ON m.id = r.member_id
        UNION
        SELECT m.tenant_id, r.field_id::text AS field_key
          FROM old_rows r JOIN public.member m ON m.id = r.member_id
      ) affected;
  END IF;

  PERFORM public.queue_automatic_memberships_for_source_changes(
    p_tenant_ids => v_tenant_ids,
    p_member_custom_keys => v_field_keys
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_queue_auto_memberships_from_organization_preferences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_ids uuid[];
  v_field_keys text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT
      COALESCE(array_agg(DISTINCT o.tenant_id), '{}'::uuid[]),
      COALESCE(array_agg(DISTINCT r.field_id::text), '{}'::text[])
      INTO v_tenant_ids, v_field_keys
      FROM new_rows r
      JOIN public.organization o ON o.id = r.organization_id;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT
      COALESCE(array_agg(DISTINCT o.tenant_id), '{}'::uuid[]),
      COALESCE(array_agg(DISTINCT r.field_id::text), '{}'::text[])
      INTO v_tenant_ids, v_field_keys
      FROM old_rows r
      JOIN public.organization o ON o.id = r.organization_id;
  ELSE
    SELECT
      COALESCE(array_agg(DISTINCT tenant_id), '{}'::uuid[]),
      COALESCE(array_agg(DISTINCT field_key), '{}'::text[])
      INTO v_tenant_ids, v_field_keys
      FROM (
        SELECT o.tenant_id, r.field_id::text AS field_key
          FROM new_rows r JOIN public.organization o ON o.id = r.organization_id
        UNION
        SELECT o.tenant_id, r.field_id::text AS field_key
          FROM old_rows r JOIN public.organization o ON o.id = r.organization_id
      ) affected;
  END IF;

  PERFORM public.queue_automatic_memberships_for_source_changes(
    p_tenant_ids => v_tenant_ids,
    p_organization_custom_keys => v_field_keys
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_queue_auto_memberships_from_new_core_rows()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_queue_auto_memberships_from_old_core_rows()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_queue_auto_memberships_from_member_updates()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_queue_auto_memberships_from_organization_updates()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_queue_auto_memberships_from_member_preferences()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_queue_auto_memberships_from_organization_preferences()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_member_auto_membership_queue_insert ON public.member;
CREATE TRIGGER trg_member_auto_membership_queue_insert
AFTER INSERT ON public.member
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_new_core_rows();

DROP TRIGGER IF EXISTS trg_member_auto_membership_queue_update ON public.member;
CREATE TRIGGER trg_member_auto_membership_queue_update
AFTER UPDATE ON public.member
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_member_updates();

DROP TRIGGER IF EXISTS trg_member_auto_membership_queue_delete ON public.member;
CREATE TRIGGER trg_member_auto_membership_queue_delete
AFTER DELETE ON public.member
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_old_core_rows();

DROP TRIGGER IF EXISTS trg_organization_auto_membership_queue_insert ON public.organization;
CREATE TRIGGER trg_organization_auto_membership_queue_insert
AFTER INSERT ON public.organization
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_new_core_rows();

DROP TRIGGER IF EXISTS trg_organization_auto_membership_queue_update ON public.organization;
CREATE TRIGGER trg_organization_auto_membership_queue_update
AFTER UPDATE ON public.organization
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_organization_updates();

DROP TRIGGER IF EXISTS trg_organization_auto_membership_queue_delete ON public.organization;
CREATE TRIGGER trg_organization_auto_membership_queue_delete
AFTER DELETE ON public.organization
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_old_core_rows();

DROP TRIGGER IF EXISTS trg_member_pref_auto_membership_queue_insert ON public.member_preference_value;
CREATE TRIGGER trg_member_pref_auto_membership_queue_insert
AFTER INSERT ON public.member_preference_value
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_member_preferences();

DROP TRIGGER IF EXISTS trg_member_pref_auto_membership_queue_update ON public.member_preference_value;
CREATE TRIGGER trg_member_pref_auto_membership_queue_update
AFTER UPDATE ON public.member_preference_value
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_member_preferences();

DROP TRIGGER IF EXISTS trg_member_pref_auto_membership_queue_delete ON public.member_preference_value;
CREATE TRIGGER trg_member_pref_auto_membership_queue_delete
AFTER DELETE ON public.member_preference_value
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_member_preferences();

DROP TRIGGER IF EXISTS trg_organization_pref_auto_membership_queue_insert ON public.organization_preference_value;
CREATE TRIGGER trg_organization_pref_auto_membership_queue_insert
AFTER INSERT ON public.organization_preference_value
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_organization_preferences();

DROP TRIGGER IF EXISTS trg_organization_pref_auto_membership_queue_update ON public.organization_preference_value;
CREATE TRIGGER trg_organization_pref_auto_membership_queue_update
AFTER UPDATE ON public.organization_preference_value
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_organization_preferences();

DROP TRIGGER IF EXISTS trg_organization_pref_auto_membership_queue_delete ON public.organization_preference_value;
CREATE TRIGGER trg_organization_pref_auto_membership_queue_delete
AFTER DELETE ON public.organization_preference_value
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_queue_auto_memberships_from_organization_preferences();

-- Remove the first-draft helper/functions after replacing their dependent
-- triggers if that draft was applied during development.
DROP FUNCTION IF EXISTS public.trg_queue_automatic_memberships_from_new_tenants();
DROP FUNCTION IF EXISTS public.trg_queue_automatic_memberships_from_old_tenants();
DROP FUNCTION IF EXISTS public.trg_queue_automatic_memberships_from_updated_tenants();
DROP FUNCTION IF EXISTS public.queue_automatic_memberships_for_tenants(uuid[]);

NOTIFY pgrst, 'reload schema';