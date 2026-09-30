-- Task #3306: atomic add/remove of a role id in resource_category.excluded_role_ids.
-- A client read-modify-write of the whole array can clobber a concurrent
-- admin's change; this function performs the mutation in one UPDATE so only
-- the single role id is added/removed, whatever the current array holds.
CREATE OR REPLACE FUNCTION resource_category_set_role_access(
  p_category_id uuid,
  p_tenant_id uuid,
  p_role_id text,
  p_has_access boolean
) RETURNS jsonb
LANGUAGE sql
AS $$
  UPDATE resource_category
  SET excluded_role_ids = CASE
    WHEN p_has_access THEN
      COALESCE(
        (SELECT jsonb_agg(e) FROM jsonb_array_elements_text(COALESCE(excluded_role_ids, '[]'::jsonb)) e
         WHERE e <> p_role_id),
        '[]'::jsonb
      )
    ELSE
      CASE
        WHEN COALESCE(excluded_role_ids, '[]'::jsonb) @> to_jsonb(ARRAY[p_role_id]) THEN excluded_role_ids
        ELSE COALESCE(excluded_role_ids, '[]'::jsonb) || to_jsonb(ARRAY[p_role_id])
      END
  END
  WHERE id = p_category_id AND tenant_id = p_tenant_id
  RETURNING excluded_role_ids;
$$;
