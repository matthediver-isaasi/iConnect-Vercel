-- Durable continuation for the hourly renewal worker. Apply before deploying
-- the bounded runner. A lease outlives Vercel's 60-second invocation ceiling;
-- it is deliberately never renewed by an invocation.
CREATE TABLE IF NOT EXISTS public.membership_renewal_cron_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner uuid,
  lease_until timestamptz,
  state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.membership_renewal_cron_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.membership_renewal_cron_state FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_membership_renewal_cron(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.membership_renewal_cron_state%ROWTYPE;
BEGIN
  IF p_owner IS NULL THEN
    RAISE EXCEPTION 'A renewal cron owner is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.membership_renewal_cron_state AS current_state
    (singleton, owner, lease_until)
  VALUES (true, p_owner, clock_timestamp() + interval '120 seconds')
  ON CONFLICT (singleton) DO UPDATE
    SET owner = EXCLUDED.owner,
        lease_until = clock_timestamp() + interval '120 seconds',
        updated_at = clock_timestamp()
    WHERE current_state.owner IS NULL
       OR current_state.lease_until IS NULL
       OR current_state.lease_until <= clock_timestamp()
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- Do not expose the other worker's continuation to an unclaimed invocation.
    RETURN jsonb_build_object('claimed', false);
  END IF;
  RETURN jsonb_build_object(
    'claimed', true, 'state', v_row.state, 'lease_until', v_row.lease_until
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_membership_renewal_cron(
  p_owner uuid,
  p_state jsonb,
  p_release boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.membership_renewal_cron_state%ROWTYPE;
BEGIN
  IF p_owner IS NULL OR p_state IS NULL OR jsonb_typeof(p_state) <> 'object'
      OR p_release IS NULL THEN
    RAISE EXCEPTION 'A renewal cron owner, object state and release flag are required'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.membership_renewal_cron_state
    SET state = p_state,
        owner = CASE WHEN p_release THEN NULL ELSE owner END,
        lease_until = CASE WHEN p_release THEN NULL ELSE lease_until END,
        updated_at = clock_timestamp()
    WHERE singleton = true
      AND owner = p_owner
      AND lease_until > clock_timestamp()
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Renewal cron lease ownership lost' USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object(
    'saved', true, 'released', p_release, 'lease_until', v_row.lease_until
  );
END;
$$;

-- Deliberately not limited: the caller orders by tenant_id and pages this RPC.
-- Expiry-only tenants remain discoverable after their config becomes inactive.
CREATE OR REPLACE FUNCTION public.membership_renewal_cron_tenants()
RETURNS TABLE (tenant_id uuid, scheduled_hour integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH tenants AS (
    SELECT c.tenant_id FROM public.membership_tier_config c WHERE c.effective_to IS NULL
    UNION
    SELECT h.tenant_id FROM public.member_membership_history h WHERE h.expiry_enforced_at IS NULL
    UNION
    SELECT h.tenant_id FROM public.organisation_membership_history h WHERE h.expiry_enforced_at IS NULL
  )
  SELECT t.tenant_id,
    CASE WHEN s.setting_value ~ '^([01]?[0-9]|2[0-3])(:[0-5][0-9])?$'
      THEN split_part(s.setting_value, ':', 1)::integer
      ELSE 6
    END AS scheduled_hour
  FROM tenants t
  LEFT JOIN LATERAL (
    SELECT ss.setting_value::text AS setting_value
    FROM public.system_settings ss
    WHERE ss.tenant_id = t.tenant_id AND ss.setting_key = 'membership_cron_time'
    ORDER BY ss.setting_value::text
    LIMIT 1
  ) s ON true
  WHERE t.tenant_id IS NOT NULL
  ORDER BY t.tenant_id;
$$;

REVOKE ALL ON FUNCTION public.claim_membership_renewal_cron(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_membership_renewal_cron(uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.membership_renewal_cron_tenants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_membership_renewal_cron(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_membership_renewal_cron(uuid, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.membership_renewal_cron_tenants() TO service_role;

-- Shared names with the expiry journal migration make either deployment order
-- safe and avoid duplicate indexes.
CREATE INDEX IF NOT EXISTS member_membership_history_expiry_keyset_idx
  ON public.member_membership_history (tenant_id, id) WHERE expiry_enforced_at IS NULL;
CREATE INDEX IF NOT EXISTS organisation_membership_history_expiry_keyset_idx
  ON public.organisation_membership_history (tenant_id, id) WHERE expiry_enforced_at IS NULL;
CREATE INDEX IF NOT EXISTS member_organisation_expiry_keyset_idx
  ON public.member (tenant_id, organization_id, id);