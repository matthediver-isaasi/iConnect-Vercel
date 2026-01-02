-- Supabase SQL function for member deduplication
-- Run this in Supabase SQL Editor to create the functions
-- NOTE: This version handles mixed UUID/TEXT column types

-- Drop ALL existing versions of these functions first
DROP FUNCTION IF EXISTS preview_duplicate_members(UUID[], UUID[], INTEGER);
DROP FUNCTION IF EXISTS preview_duplicate_members(TEXT[], TEXT[], INTEGER);
DROP FUNCTION IF EXISTS preview_duplicate_members;
DROP FUNCTION IF EXISTS execute_duplicate_members(UUID[], UUID[]);
DROP FUNCTION IF EXISTS execute_duplicate_members(TEXT[], TEXT[]);
DROP FUNCTION IF EXISTS execute_duplicate_members;

-- Function to preview duplicate members (returns summary and first N groups)
CREATE OR REPLACE FUNCTION preview_duplicate_members(
  exclude_org_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  exclude_role_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  max_groups INTEGER DEFAULT 100
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSON;
BEGIN
  WITH filtered_members AS (
    SELECT 
      id::text as id,
      email,
      first_name,
      last_name,
      role_id::text as role_id,
      organization_id::text as organization_id,
      created_on
    FROM member
    WHERE email IS NOT NULL 
      AND TRIM(email) != ''
      AND (
        cardinality(exclude_org_ids) = 0 
        OR organization_id IS NULL 
        OR NOT (organization_id::text = ANY(exclude_org_ids))
      )
      AND (
        cardinality(exclude_role_ids) = 0 
        OR role_id IS NULL 
        OR NOT (role_id::text = ANY(exclude_role_ids))
      )
  ),
  ranked_members AS (
    SELECT 
      *,
      LOWER(TRIM(email)) as email_lower,
      ROW_NUMBER() OVER (
        PARTITION BY LOWER(TRIM(email)) 
        ORDER BY 
          (role_id IS NULL)::int,
          COALESCE(created_on, '1970-01-01'::date),
          id
      ) as rn,
      COUNT(*) OVER (PARTITION BY LOWER(TRIM(email))) as group_count
    FROM filtered_members
  ),
  duplicates AS (
    SELECT * FROM ranked_members WHERE group_count > 1
  ),
  summary AS (
    SELECT 
      COUNT(DISTINCT email_lower) as total_duplicate_emails,
      COUNT(*) FILTER (WHERE rn = 1) as total_keepers,
      COUNT(*) FILTER (WHERE rn > 1) as total_to_delete
    FROM duplicates
  ),
  sample_groups AS (
    SELECT 
      email_lower,
      json_agg(
        json_build_object(
          'id', id,
          'email', email,
          'first_name', first_name,
          'last_name', last_name,
          'role_id', role_id,
          'organization_id', organization_id,
          'created_on', created_on,
          'is_keeper', rn = 1
        ) ORDER BY rn
      ) as members
    FROM duplicates
    WHERE email_lower IN (
      SELECT DISTINCT email_lower 
      FROM duplicates 
      LIMIT max_groups
    )
    GROUP BY email_lower
  )
  SELECT json_build_object(
    'success', true,
    'mode', 'preview',
    'summary', (SELECT row_to_json(summary) FROM summary),
    'groups', COALESCE(
      (SELECT json_agg(
        json_build_object(
          'email', email_lower,
          'members', members
        )
      ) FROM sample_groups),
      '[]'::json
    )
  ) INTO result;
  
  RETURN result;
END;
$$;

-- Function to execute member deduplication (deletes duplicates, keeps one per email)
CREATE OR REPLACE FUNCTION execute_duplicate_members(
  exclude_org_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  exclude_role_ids TEXT[] DEFAULT ARRAY[]::TEXT[]
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER := 0;
  keeper_count INTEGER := 0;
  result JSON;
BEGIN
  -- Create temp table with ranked members (all IDs as text to avoid type issues)
  CREATE TEMP TABLE temp_dedupe AS
  WITH filtered_members AS (
    SELECT 
      id::text as id,
      email,
      role_id::text as role_id,
      organization_id::text as organization_id,
      created_on
    FROM member
    WHERE email IS NOT NULL 
      AND TRIM(email) != ''
      AND (
        cardinality(exclude_org_ids) = 0 
        OR organization_id IS NULL 
        OR NOT (organization_id::text = ANY(exclude_org_ids))
      )
      AND (
        cardinality(exclude_role_ids) = 0 
        OR role_id IS NULL 
        OR NOT (role_id::text = ANY(exclude_role_ids))
      )
  )
  SELECT 
    id,
    LOWER(TRIM(email)) as email_lower,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(TRIM(email)) 
      ORDER BY 
        (role_id IS NULL)::int,
        COALESCE(created_on, '1970-01-01'::date),
        id
    ) as rn,
    FIRST_VALUE(id) OVER (
      PARTITION BY LOWER(TRIM(email)) 
      ORDER BY 
        (role_id IS NULL)::int,
        COALESCE(created_on, '1970-01-01'::date),
        id
    ) as keeper_id,
    COUNT(*) OVER (PARTITION BY LOWER(TRIM(email))) as group_count
  FROM filtered_members;

  -- Get counts
  SELECT COUNT(DISTINCT email_lower) INTO keeper_count
  FROM temp_dedupe WHERE group_count > 1;

  -- Update member_note references (target_member_id) - cast for comparison
  UPDATE member_note mn
  SET target_member_id = td.keeper_id::uuid
  FROM temp_dedupe td
  WHERE mn.target_member_id::text = td.id
    AND td.rn > 1
    AND td.group_count > 1;

  -- Update member_note references (author_member_id) - cast for comparison
  UPDATE member_note mn
  SET author_member_id = td.keeper_id::uuid
  FROM temp_dedupe td
  WHERE mn.author_member_id::text = td.id
    AND td.rn > 1
    AND td.group_count > 1;

  -- Update organization_note references - cast for comparison
  UPDATE organization_note orgn
  SET member_id = td.keeper_id::uuid
  FROM temp_dedupe td
  WHERE orgn.member_id::text = td.id
    AND td.rn > 1
    AND td.group_count > 1;

  -- Update member_group_assignment references - reassign to keeper
  UPDATE member_group_assignment mga
  SET member_id = td.keeper_id::uuid
  FROM temp_dedupe td
  WHERE mga.member_id::text = td.id
    AND td.rn > 1
    AND td.group_count > 1;

  -- Delete any duplicate member_group_assignment rows that would violate unique constraints
  -- (keeper might already have same group assignment)
  DELETE FROM member_group_assignment mga
  WHERE EXISTS (
    SELECT 1 FROM member_group_assignment mga2
    WHERE mga2.member_id = mga.member_id
      AND mga2.group_id = mga.group_id
      AND mga2.id < mga.id
  );

  -- Delete duplicates (keep rn=1) - cast for comparison
  DELETE FROM member m
  USING temp_dedupe td
  WHERE m.id::text = td.id
    AND td.rn > 1
    AND td.group_count > 1;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  -- Cleanup
  DROP TABLE temp_dedupe;

  -- Return result
  SELECT json_build_object(
    'success', true,
    'mode', 'execute',
    'deleted', deleted_count,
    'summary', json_build_object(
      'totalDuplicateEmails', keeper_count,
      'totalDeleted', deleted_count
    )
  ) INTO result;

  RETURN result;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION preview_duplicate_members(TEXT[], TEXT[], INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION preview_duplicate_members(TEXT[], TEXT[], INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION execute_duplicate_members(TEXT[], TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION execute_duplicate_members(TEXT[], TEXT[]) TO service_role;
