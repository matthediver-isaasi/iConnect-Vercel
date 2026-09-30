-- Supabase SQL function for bulk member imports
-- Run this in Supabase SQL Editor, or apply via scripts/apply-import-members-function.mjs

-- Drop any previous signatures (the original took only the batch and did NOT
-- set tenant_id, which created tenant-less members invisible to /members).
DROP FUNCTION IF EXISTS process_member_import_batch(JSONB);
DROP FUNCTION IF EXISTS process_member_import_batch(JSONB, UUID);

-- Function to process a batch of member records for a single tenant.
-- p_tenant_id is REQUIRED: every inserted member is stamped with it, and all
-- lookups (existing members, roles, organizations) are scoped to that tenant so
-- an import can never read or modify another tenant's data.
CREATE OR REPLACE FUNCTION process_member_import_batch(
  batch JSONB,
  p_tenant_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  created_count INTEGER := 0;
  updated_count INTEGER := 0;
  skipped_count INTEGER := 0;
  error_count INTEGER := 0;
  rec RECORD;
  existing_id UUID;
  role_id_val UUID;
  org_id_val UUID;
  new_member_id UUID;
  result JSON;
  err_msg TEXT;
  first_error TEXT := NULL;
BEGIN
  -- A tenant is mandatory; without it members would be orphaned.
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'process_member_import_batch requires a non-null p_tenant_id';
  END IF;

  -- Drop temp tables if they exist from previous calls
  DROP TABLE IF EXISTS temp_import;
  DROP TABLE IF EXISTS temp_roles;
  DROP TABLE IF EXISTS temp_orgs;
  DROP TABLE IF EXISTS temp_existing;

  -- Create temp table from JSON batch
  CREATE TEMP TABLE temp_import AS
  SELECT 
    (row_data->>'email')::text as email,
    (row_data->>'first_name')::text as first_name,
    (row_data->>'last_name')::text as last_name,
    (row_data->>'role_name')::text as role_name,
    (row_data->>'organization_name')::text as organization_name,
    (row_data->>'mobile')::text as mobile,
    (row_data->>'landline')::text as landline,
    (row_data->>'job_title')::text as job_title,
    (row_data->>'role_effective_from')::text as role_effective_from,
    (row_data->>'created_on')::text as created_on,
    (row_data->>'row_index')::integer as row_index
  FROM jsonb_array_elements(batch) AS row_data;

  -- Build role lookup (scoped to this tenant)
  CREATE TEMP TABLE temp_roles AS
  SELECT id as role_id, lower(trim(name)) as role_name_lower
  FROM role
  WHERE tenant_id = p_tenant_id;

  -- Build organization lookup (scoped to this tenant)
  CREATE TEMP TABLE temp_orgs AS
  SELECT id as org_id, lower(trim(name)) as org_name_lower
  FROM organization
  WHERE tenant_id = p_tenant_id;

  -- Build existing member lookup (case-insensitive email, scoped to this tenant)
  CREATE TEMP TABLE temp_existing AS
  SELECT id as member_id, lower(trim(email)) as email_lower
  FROM member
  WHERE tenant_id = p_tenant_id AND email IS NOT NULL AND trim(email) != '';

  -- Process each row
  FOR rec IN SELECT * FROM temp_import LOOP
    BEGIN
      -- Skip if no email
      IF rec.email IS NULL OR trim(rec.email) = '' THEN
        skipped_count := skipped_count + 1;
        CONTINUE;
      END IF;

      -- Look up role by name (case-insensitive)
      role_id_val := NULL;
      IF rec.role_name IS NOT NULL AND trim(rec.role_name) != '' THEN
        SELECT role_id INTO role_id_val
        FROM temp_roles
        WHERE role_name_lower = lower(trim(rec.role_name))
        LIMIT 1;
      END IF;

      -- Look up organization by name (case-insensitive)
      org_id_val := NULL;
      IF rec.organization_name IS NOT NULL AND trim(rec.organization_name) != '' THEN
        SELECT org_id INTO org_id_val
        FROM temp_orgs
        WHERE org_name_lower = lower(trim(rec.organization_name))
        LIMIT 1;
      END IF;

      -- Check if member exists (case-insensitive email, within this tenant)
      existing_id := NULL;
      SELECT member_id INTO existing_id
      FROM temp_existing
      WHERE email_lower = lower(trim(rec.email))
      LIMIT 1;

      IF existing_id IS NOT NULL THEN
        -- Update existing member. Email is normalized to lowercase so a
        -- re-import repairs any pre-existing mixed-case email and keeps it
        -- consistent with the login resolver's lower(email) lookup.
        UPDATE member
        SET 
          email = lower(trim(rec.email)),
          first_name = COALESCE(NULLIF(trim(rec.first_name), ''), first_name),
          last_name = COALESCE(NULLIF(trim(rec.last_name), ''), last_name),
          mobile = COALESCE(NULLIF(trim(rec.mobile), ''), mobile),
          landline = COALESCE(NULLIF(trim(rec.landline), ''), landline),
          job_title = COALESCE(NULLIF(trim(rec.job_title), ''), job_title),
          role_id = COALESCE(role_id_val, role_id),
          role_effective_from = CASE 
            WHEN rec.role_effective_from IS NOT NULL AND trim(rec.role_effective_from) != '' 
            THEN rec.role_effective_from::date 
            ELSE role_effective_from 
          END,
          organization_id = COALESCE(org_id_val, organization_id),
          created_on = CASE 
            WHEN rec.created_on IS NOT NULL AND trim(rec.created_on) != '' 
            THEN rec.created_on::timestamptz 
            ELSE created_on 
          END
        WHERE id = existing_id;
        
        updated_count := updated_count + 1;
      ELSE
        -- Insert new member (stamped with the importing tenant).
        -- Email is lowercased to match the app-wide convention and the login
        -- resolver's lower(email) lookup, so imported members always resolve.
        INSERT INTO member (email, first_name, last_name, mobile, landline, job_title, role_id, role_effective_from, organization_id, created_on, tenant_id)
        VALUES (
          lower(trim(rec.email)),
          NULLIF(trim(rec.first_name), ''),
          NULLIF(trim(rec.last_name), ''),
          NULLIF(trim(rec.mobile), ''),
          NULLIF(trim(rec.landline), ''),
          NULLIF(trim(rec.job_title), ''),
          role_id_val,
          CASE WHEN rec.role_effective_from IS NOT NULL AND trim(rec.role_effective_from) != '' THEN rec.role_effective_from::date ELSE NULL END,
          org_id_val,
          CASE WHEN rec.created_on IS NOT NULL AND trim(rec.created_on) != '' THEN rec.created_on::timestamptz ELSE NULL END,
          p_tenant_id
        )
        RETURNING id INTO new_member_id;
        
        created_count := created_count + 1;
        
        -- Add to existing lookup to prevent duplicates within batch
        INSERT INTO temp_existing (member_id, email_lower)
        VALUES (new_member_id, lower(trim(rec.email)));
      END IF;

    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS err_msg = MESSAGE_TEXT;
      IF first_error IS NULL THEN
        first_error := 'Row ' || COALESCE(rec.row_index::text, '?') || ': ' || err_msg;
      END IF;
      error_count := error_count + 1;
    END;
  END LOOP;

  -- Cleanup temp tables
  DROP TABLE IF EXISTS temp_import;
  DROP TABLE IF EXISTS temp_roles;
  DROP TABLE IF EXISTS temp_orgs;
  DROP TABLE IF EXISTS temp_existing;

  -- Return summary with first error for debugging
  SELECT json_build_object(
    'success', true,
    'created', created_count,
    'updated', updated_count,
    'skipped', skipped_count,
    'errors', error_count,
    'total', created_count + updated_count + skipped_count + error_count,
    'first_error', first_error
  ) INTO result;

  RETURN result;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION process_member_import_batch(JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION process_member_import_batch(JSONB, UUID) TO service_role;
