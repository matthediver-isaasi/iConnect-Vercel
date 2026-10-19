BEGIN;

-- Server-only data transport, NOT a publication/authorization API. The handler
-- still resolves tenant context and role authority afresh on all three passes.
-- STABLE gives every read in an invocation the same MVCC statement snapshot.
CREATE OR REPLACE FUNCTION public.organization_carousel_snapshot(
  p_tenant_id uuid,
  p_source text,
  p_directory_id text DEFAULT NULL,
  p_slug text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '10s'
AS $function$
DECLARE
  result jsonb;
  sizes jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_source IS NULL
    OR p_source NOT IN ('dynamic', 'primary-organization')
    OR (p_source = 'dynamic' AND coalesce(p_directory_id, p_slug, '') = '')
    OR octet_length(coalesce(p_directory_id, '')) > 2000
    OR octet_length(coalesce(p_slug, '')) > 2000 THEN
    RAISE EXCEPTION 'Invalid organisation carousel snapshot selector' USING ERRCODE = '22023';
  END IF;

  WITH directories AS MATERIALIZED (
    SELECT d.id, d.tenant_id, d.slug, d.entity_type, d.is_active,
      d.allowed_role_ids,
      -- Default-off even during the earlier consent migration rollout.
      to_jsonb(d)->'public_carousel_enabled' AS public_carousel_enabled,
      to_jsonb(d)->'filter_expression' AS filter_expression,
      d.filter_field_id, d.filter_value
    FROM public.dynamic_directory d
    WHERE p_source = 'dynamic' AND d.tenant_id = p_tenant_id AND d.is_active = true
      AND CASE WHEN p_directory_id IS NOT NULL THEN d.id::text = p_directory_id ELSE d.slug = p_slug END
    ORDER BY d.id LIMIT 2
  ), mode AS MATERIALIZED (
    SELECT NOT EXISTS (SELECT 1 FROM directories WHERE entity_type <> 'organization' OR entity_type IS NULL) AS supported
  ), referenced_fields AS MATERIALIZED (
    SELECT d.filter_field_id::text AS id FROM directories d WHERE d.filter_expression IS NULL OR d.filter_expression = 'null'::jsonb
    UNION
    SELECT v #>> '{}' FROM directories d,
      LATERAL jsonb_path_query(d.filter_expression, '$.**.field_id') v
  ), fields AS MATERIALIZED (
    SELECT f.id, f.tenant_id, f.entity_scope, f.is_active, f.name, f.field_type
    FROM public.preference_field f, mode
    WHERE mode.supported AND f.tenant_id = p_tenant_id AND f.entity_scope = 'organization'
      AND (f.id::text IN (SELECT id FROM referenced_fields)
        OR f.name IN ('application_status', 'org_type', 'organisation_type', 'organization_type')
        OR (f.name = 'verified_domains' AND f.is_active = true))
    ORDER BY f.id LIMIT 10001
  ), organizations AS MATERIALIZED (
    SELECT o.id, o.tenant_id, o.name, o.logo_url
    FROM public.organization o, mode
    WHERE mode.supported AND o.tenant_id = p_tenant_id
    ORDER BY o.id LIMIT 100001
  ), settings AS MATERIALIZED (
    SELECT s.id, s.tenant_id, s.setting_key, s.setting_value
    FROM public.system_settings s, mode
    WHERE mode.supported AND s.tenant_id = p_tenant_id
      AND s.setting_key IN ('org_directory_public_carousel_enabled',
        'org_directory_show_logo', 'org_directory_show_title', 'org_directory_show_domains',
        'org_directory_excluded_orgs', 'org_directory_allowed_application_statuses',
        'org_directory_visible_org_types')
    ORDER BY s.id LIMIT 101
  ), preference_values AS MATERIALIZED (
    SELECT v.id, v.organization_id, v.field_id, v.value
    FROM public.organization_preference_value v
    -- Values have no tenant column: independently constrain BOTH parents.
    JOIN organizations o ON o.id = v.organization_id AND o.tenant_id = p_tenant_id
    JOIN fields f ON f.id = v.field_id AND f.tenant_id = p_tenant_id AND f.entity_scope = 'organization'
    ORDER BY v.id LIMIT 100001
  ), rows AS MATERIALIZED (
    SELECT 'dynamic_directory' AS tab, d.id::text AS id, to_jsonb(d) AS row FROM directories d
    UNION ALL SELECT 'system_settings', s.id::text, to_jsonb(s) FROM settings s
    UNION ALL SELECT 'preference_field', f.id::text, to_jsonb(f) FROM fields f
    UNION ALL SELECT 'organization', o.id::text, to_jsonb(o) FROM organizations o
    UNION ALL SELECT 'organization_preference_value', v.id::text, to_jsonb(v) FROM preference_values v
  ), stats AS MATERIALIZED (
    SELECT coalesce(sum(octet_length(row::text)), 0) AS bytes,
      coalesce(max(octet_length(row::text)), 0) AS row_bytes FROM rows
  ), grouped AS (
    SELECT tab, jsonb_agg(row ORDER BY id COLLATE "C") AS items
    FROM rows, stats
    -- Do not build an oversized JSON aggregate only to reject it afterwards.
    WHERE stats.bytes <= 33550000 AND stats.row_bytes <= 65536
    GROUP BY tab
  )
  SELECT jsonb_build_object(
      'version', 1, 'tenant_id', p_tenant_id,
      'unsupported_entity', NOT mode.supported,
      'dynamic_directory', coalesce((SELECT items FROM grouped WHERE tab = 'dynamic_directory'), '[]'::jsonb),
      'system_settings', coalesce((SELECT items FROM grouped WHERE tab = 'system_settings'), '[]'::jsonb),
      'preference_field', coalesce((SELECT items FROM grouped WHERE tab = 'preference_field'), '[]'::jsonb),
      'organization', coalesce((SELECT items FROM grouped WHERE tab = 'organization'), '[]'::jsonb),
      'organization_preference_value', coalesce((SELECT items FROM grouped WHERE tab = 'organization_preference_value'), '[]'::jsonb)
    ), jsonb_build_object('bytes', stats.bytes, 'row_bytes', stats.row_bytes,
      'settings', (SELECT count(*) FROM settings), 'fields', (SELECT count(*) FROM fields),
      'organizations', (SELECT count(*) FROM organizations), 'values', (SELECT count(*) FROM preference_values))
  INTO result, sizes FROM mode, stats;

  IF (sizes->>'bytes')::bigint > 33550000 OR (sizes->>'row_bytes')::bigint > 65536
    OR (sizes->>'settings')::bigint > 100 OR (sizes->>'fields')::bigint > 10000
    OR (sizes->>'organizations')::bigint > 100000 OR (sizes->>'values')::bigint > 100000
    OR octet_length(result::text) > 33554432 THEN
    RAISE EXCEPTION 'Organisation carousel snapshot exceeds safety limits' USING ERRCODE = '54000';
  END IF;
  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.organization_carousel_snapshot(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.organization_carousel_snapshot(uuid, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.organization_carousel_snapshot(uuid, text, text, text) TO service_role;

COMMENT ON FUNCTION public.organization_carousel_snapshot(uuid, text, text, text)
  IS 'Service-only bounded atomic organisation carousel input; never return this snapshot publicly.';
NOTIFY pgrst, 'reload schema';
COMMIT;
