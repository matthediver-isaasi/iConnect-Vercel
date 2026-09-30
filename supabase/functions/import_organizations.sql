-- Supabase SQL function for bulk organisation imports.
-- Run this in the Supabase SQL Editor, or apply via
-- scripts/apply-import-organizations-function.mjs (IPv4 pooler / DEST_DATABASE_URL).
--
-- This is the organisation equivalent of process_member_import_batch: it does all
-- of the per-row lookup + upsert work inside Postgres so a 1,000-row batch costs a
-- single network round-trip instead of several per row. Only the columns that
-- actually exist on the organization table are handled; custom values and notes
-- are persisted separately (set-based) by api/imports/execute.js.

-- Drop any previous signatures so re-applying is idempotent.
DROP FUNCTION IF EXISTS process_organization_import_batch(JSONB);
DROP FUNCTION IF EXISTS process_organization_import_batch(JSONB, UUID);

-- Process a batch of organisation records for a single tenant.
-- p_tenant_id is REQUIRED: every inserted organisation is stamped with it and all
-- lookups are scoped to it, so an import can never read or modify another tenant's
-- data. Matching is by name (case-insensitive) within the tenant.
CREATE OR REPLACE FUNCTION process_organization_import_batch(
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
  new_org_id UUID;
  result JSON;
  err_msg TEXT;
  first_error TEXT := NULL;
BEGIN
  -- A tenant is mandatory; without it organisations would be orphaned.
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'process_organization_import_batch requires a non-null p_tenant_id';
  END IF;

  -- Drop temp tables if they exist from previous calls in this session.
  DROP TABLE IF EXISTS temp_org_import;
  DROP TABLE IF EXISTS temp_org_existing;

  -- Materialise the JSON batch into a temp table.
  CREATE TEMP TABLE temp_org_import AS
  SELECT
    (row_data->>'name')::text         AS name,
    (row_data->>'description')::text  AS description,
    (row_data->>'website_url')::text  AS website_url,
    (row_data->>'logo_url')::text     AS logo_url,
    (row_data->>'email')::text        AS email,
    (row_data->>'phone')::text        AS phone,
    (row_data->>'status')::text       AS status,
    (row_data->>'created_at')::text   AS created_at,
    (row_data->>'row_index')::integer AS row_index
  FROM jsonb_array_elements(batch) AS row_data;

  -- Existing-organisation lookup (case-insensitive name, scoped to this tenant).
  CREATE TEMP TABLE temp_org_existing AS
  SELECT id AS org_id, lower(trim(name)) AS name_lower
  FROM organization
  WHERE tenant_id = p_tenant_id AND name IS NOT NULL AND trim(name) != '';

  FOR rec IN SELECT * FROM temp_org_import LOOP
    BEGIN
      -- Skip rows without a usable identifier (name).
      IF rec.name IS NULL OR trim(rec.name) = '' THEN
        skipped_count := skipped_count + 1;
        CONTINUE;
      END IF;

      existing_id := NULL;
      SELECT org_id INTO existing_id
      FROM temp_org_existing
      WHERE name_lower = lower(trim(rec.name))
      LIMIT 1;

      IF existing_id IS NOT NULL THEN
        -- Non-destructive update: only overwrite a column when the import supplies
        -- a non-empty value (COALESCE / NULLIF), mirroring the member path.
        UPDATE organization
        SET
          name        = COALESCE(NULLIF(trim(rec.name), ''), name),
          description = COALESCE(NULLIF(trim(rec.description), ''), description),
          website_url = COALESCE(NULLIF(trim(rec.website_url), ''), website_url),
          logo_url    = COALESCE(NULLIF(trim(rec.logo_url), ''), logo_url),
          email       = COALESCE(lower(NULLIF(trim(rec.email), '')), email),
          phone       = COALESCE(NULLIF(trim(rec.phone), ''), phone),
          status      = COALESCE(NULLIF(trim(rec.status), ''), status),
          created_at  = CASE
            WHEN rec.created_at IS NOT NULL AND trim(rec.created_at) != ''
            THEN rec.created_at::timestamptz
            ELSE created_at
          END,
          updated_at  = NOW()
        WHERE id = existing_id;

        updated_count := updated_count + 1;
      ELSE
        INSERT INTO organization (
          name, description, website_url, logo_url, email, phone, status,
          created_at, tenant_id
        )
        VALUES (
          NULLIF(trim(rec.name), ''),
          NULLIF(trim(rec.description), ''),
          NULLIF(trim(rec.website_url), ''),
          NULLIF(trim(rec.logo_url), ''),
          lower(NULLIF(trim(rec.email), '')),
          NULLIF(trim(rec.phone), ''),
          COALESCE(NULLIF(trim(rec.status), ''), 'active'),
          CASE
            WHEN rec.created_at IS NOT NULL AND trim(rec.created_at) != ''
            THEN rec.created_at::timestamptz
            ELSE NOW()
          END,
          p_tenant_id
        )
        RETURNING id INTO new_org_id;

        created_count := created_count + 1;

        -- Register the new org so later rows in the same batch update (not
        -- duplicate) it.
        INSERT INTO temp_org_existing (org_id, name_lower)
        VALUES (new_org_id, lower(trim(rec.name)));
      END IF;

    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS err_msg = MESSAGE_TEXT;
      IF first_error IS NULL THEN
        first_error := 'Row ' || COALESCE(rec.row_index::text, '?') || ': ' || err_msg;
      END IF;
      error_count := error_count + 1;
    END;
  END LOOP;

  DROP TABLE IF EXISTS temp_org_import;
  DROP TABLE IF EXISTS temp_org_existing;

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

GRANT EXECUTE ON FUNCTION process_organization_import_batch(JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION process_organization_import_batch(JSONB, UUID) TO service_role;
