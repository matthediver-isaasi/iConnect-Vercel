-- Task #3320: atomic add/remove of a role id inside one subcategory's entry of
-- resource_category.subcategory_excluded_role_ids. Mirrors
-- resource_category_set_role_access(): the mutation happens in a single UPDATE
-- so only this (subcategory, role) pair changes, whatever the current map
-- holds — concurrent edits by other admins are never clobbered. Idempotent.
-- When re-granting access empties a subcategory's array, the key is removed so
-- the map stays clean.
CREATE OR REPLACE FUNCTION resource_category_set_subcategory_role_access(
  p_category_id uuid,
  p_tenant_id uuid,
  p_role_id text,
  p_subcategory text,
  p_has_access boolean
) RETURNS jsonb
LANGUAGE sql
AS $$
  UPDATE resource_category
  SET subcategory_excluded_role_ids = CASE
    WHEN p_has_access THEN
      -- Remove the role id from this subcategory's array; drop the key when empty.
      CASE
        WHEN NOT (COALESCE(subcategory_excluded_role_ids, '{}'::jsonb) ? p_subcategory)
          THEN COALESCE(subcategory_excluded_role_ids, '{}'::jsonb)
        ELSE (
          SELECT CASE
            WHEN new_arr = '[]'::jsonb
              THEN COALESCE(subcategory_excluded_role_ids, '{}'::jsonb) - p_subcategory
            ELSE jsonb_set(COALESCE(subcategory_excluded_role_ids, '{}'::jsonb), ARRAY[p_subcategory], new_arr)
          END
          FROM (
            SELECT COALESCE(
              (SELECT jsonb_agg(e)
               FROM jsonb_array_elements_text(subcategory_excluded_role_ids -> p_subcategory) e
               WHERE e <> p_role_id),
              '[]'::jsonb
            ) AS new_arr
          ) s
        )
      END
    ELSE
      -- Add the role id to this subcategory's array (no-op if already present).
      CASE
        WHEN COALESCE(subcategory_excluded_role_ids -> p_subcategory, '[]'::jsonb) @> to_jsonb(ARRAY[p_role_id])
          THEN COALESCE(subcategory_excluded_role_ids, '{}'::jsonb)
        ELSE jsonb_set(
          COALESCE(subcategory_excluded_role_ids, '{}'::jsonb),
          ARRAY[p_subcategory],
          COALESCE(subcategory_excluded_role_ids -> p_subcategory, '[]'::jsonb) || to_jsonb(ARRAY[p_role_id])
        )
      END
  END
  WHERE id = p_category_id AND tenant_id = p_tenant_id
  RETURNING subcategory_excluded_role_ids;
$$;
