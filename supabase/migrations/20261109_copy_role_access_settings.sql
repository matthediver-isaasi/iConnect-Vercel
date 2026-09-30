-- Task 4637. Service-only atomic replacement; identity and deprecated is_admin
-- intentionally remain untouched. The HTTP boundary supplies verified authority.
CREATE OR REPLACE FUNCTION public.copy_role_access_settings(
  p_tenant_id uuid, p_source_role_id uuid, p_target_role_id uuid,
  p_can_manage_tenant_admin boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  source_role public.role%ROWTYPE;
  target_role public.role%ROWTYPE;
  category record;
  exclusions jsonb;
  sub_exclusions jsonb;
  entry record;
  ids jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_source_role_id IS NULL OR p_target_role_id IS NULL
     OR p_source_role_id = p_target_role_id THEN
    RAISE EXCEPTION 'Distinct roles and tenant required' USING ERRCODE = '22023';
  END IF;
  -- Tenant-wide ordering prevents reciprocal copies/category lock inversions.
  PERFORM pg_advisory_xact_lock(hashtextextended('role-settings:' || p_tenant_id::text, 0));
  PERFORM id FROM public.role
    WHERE tenant_id = p_tenant_id AND id IN (p_source_role_id, p_target_role_id)
    ORDER BY id FOR UPDATE;
  SELECT * INTO source_role FROM public.role WHERE id = p_source_role_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO target_role FROM public.role WHERE id = p_target_role_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found' USING ERRCODE = 'P0002'; END IF;
  IF target_role.is_system IS TRUE OR
     ((source_role.is_tenant_admin IS TRUE OR target_role.is_tenant_admin IS TRUE)
       AND p_can_manage_tenant_admin IS NOT TRUE) THEN
    RAISE EXCEPTION 'Protected role settings' USING ERRCODE = '42501';
  END IF;

  UPDATE public.role SET
    excluded_features = source_role.excluded_features,
    is_tenant_admin = source_role.is_tenant_admin,
    assignable_role_ids = source_role.assignable_role_ids
  WHERE id = p_target_role_id AND tenant_id = p_tenant_id
  RETURNING * INTO target_role;

  DELETE FROM public.role_member_field_permission WHERE role_id = p_target_role_id::text;
  INSERT INTO public.role_member_field_permission (id, role_id, field_key, permission)
    SELECT gen_random_uuid()::text, p_target_role_id::text, field_key, permission
    FROM public.role_member_field_permission WHERE role_id = p_source_role_id::text;
  DELETE FROM public.role_organization_field_permission WHERE role_id = p_target_role_id::text;
  INSERT INTO public.role_organization_field_permission (id, role_id, field_key, permission)
    SELECT gen_random_uuid()::text, p_target_role_id::text, field_key, permission
    FROM public.role_organization_field_permission WHERE role_id = p_source_role_id::text;

  -- Lock category rows before reading their JSON, preserving concurrent edits
  -- made through the existing pair-wise resource access RPCs.
  FOR category IN SELECT id, excluded_role_ids, subcategory_excluded_role_ids
    FROM public.resource_category WHERE tenant_id = p_tenant_id ORDER BY id FOR UPDATE
  LOOP
    exclusions := coalesce(category.excluded_role_ids, '[]'::jsonb) - p_target_role_id::text;
    IF exclusions ? p_source_role_id::text THEN
      exclusions := exclusions || jsonb_build_array(p_target_role_id::text);
    END IF;
    sub_exclusions := coalesce(category.subcategory_excluded_role_ids, '{}'::jsonb);
    FOR entry IN SELECT key, value FROM jsonb_each(sub_exclusions)
    LOOP
      ids := entry.value - p_target_role_id::text;
      IF ids ? p_source_role_id::text THEN ids := ids || jsonb_build_array(p_target_role_id::text); END IF;
      sub_exclusions := jsonb_set(sub_exclusions, ARRAY[entry.key], ids);
    END LOOP;
    -- Preserve inherited/null representations when this role had no entries.
    IF category.excluded_role_ids IS NULL THEN exclusions := NULL; END IF;
    IF category.subcategory_excluded_role_ids IS NULL THEN sub_exclusions := NULL; END IF;
    UPDATE public.resource_category SET
      excluded_role_ids = exclusions, subcategory_excluded_role_ids = sub_exclusions
      WHERE id = category.id AND tenant_id = p_tenant_id
        AND (excluded_role_ids IS DISTINCT FROM exclusions OR subcategory_excluded_role_ids IS DISTINCT FROM sub_exclusions);
  END LOOP;
  RETURN to_jsonb(target_role);
END;
$$;
REVOKE ALL ON FUNCTION public.copy_role_access_settings(uuid,uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.copy_role_access_settings(uuid,uuid,uuid,boolean) TO service_role;