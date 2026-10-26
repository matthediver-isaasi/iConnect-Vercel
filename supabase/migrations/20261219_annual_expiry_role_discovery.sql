-- New version retains the original discovery RPC for older deployed workers.
CREATE OR REPLACE FUNCTION public.membership_renewal_cron_tenants_with_events()
RETURNS TABLE (tenant_id uuid, scheduled_hour integer, unresolved_role_events bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH events AS (
    SELECT a.tenant_id, count(*) AS pending
    FROM public.membership_expiry_action a
    WHERE a.role_event_state IN ('pending', 'review') GROUP BY a.tenant_id
  ), tenants AS (
    SELECT c.tenant_id FROM public.membership_tier_config c WHERE c.effective_to IS NULL
    UNION SELECT h.tenant_id FROM public.member_membership_history h WHERE h.expiry_enforced_at IS NULL
    UNION SELECT h.tenant_id FROM public.organisation_membership_history h WHERE h.expiry_enforced_at IS NULL
    UNION SELECT e.tenant_id FROM events e
  )
  SELECT t.tenant_id,
    CASE WHEN s.setting_value ~ '^([01]?[0-9]|2[0-3])(:[0-5][0-9])?$'
      THEN split_part(s.setting_value, ':', 1)::integer ELSE 6 END,
    coalesce(e.pending, 0)
  FROM tenants t
  LEFT JOIN events e ON e.tenant_id = t.tenant_id
  LEFT JOIN LATERAL (
    SELECT ss.setting_value::text AS setting_value FROM public.system_settings ss
    WHERE ss.tenant_id = t.tenant_id AND ss.setting_key = 'membership_cron_time'
    ORDER BY ss.setting_value::text LIMIT 1
  ) s ON true
  WHERE t.tenant_id IS NOT NULL ORDER BY t.tenant_id;
$$;
REVOKE ALL ON FUNCTION public.membership_renewal_cron_tenants_with_events() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.membership_renewal_cron_tenants_with_events() TO service_role;
