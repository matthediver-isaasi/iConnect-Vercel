-- RPC helper that returns the next batch of (tenant, entity_type)
-- candidates whose local watermark is newer than the most recent
-- successful outbound sync. Used by the outbound reconcile cron
-- (#442) to identify drifted rows efficiently — a JOIN against
-- zoho_crm_sync_state is needed to handle never-synced rows (no
-- state row at all) without overfetching client-side.
--
-- Returns id and updated_at, ordered ASC so the oldest drift drains
-- first and a long Zoho outage cannot indefinitely starve old rows.
-- The function is SECURITY INVOKER (the default) — the caller (the
-- service-role Supabase client used by the cron) provides authority.

CREATE OR REPLACE FUNCTION zoho_crm_outbound_drift_candidates(
  p_tenant_id   UUID,
  p_entity_type TEXT,
  p_limit       INTEGER DEFAULT 200
)
RETURNS TABLE(id UUID, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_entity_type = 'member' THEN
    RETURN QUERY
      SELECT e.id, e.updated_at
      FROM   member e
      LEFT   JOIN zoho_crm_sync_state s
             ON  s.tenant_id   = e.tenant_id
             AND s.entity_type = 'member'
             AND s.entity_id   = e.id
             AND s.direction   = 'outbound'
      WHERE  e.tenant_id = p_tenant_id
      AND    (s.last_synced_at IS NULL OR e.updated_at > s.last_synced_at)
      ORDER  BY e.updated_at ASC
      LIMIT  p_limit;
  ELSIF p_entity_type = 'organization' THEN
    RETURN QUERY
      SELECT e.id, e.updated_at
      FROM   organization e
      LEFT   JOIN zoho_crm_sync_state s
             ON  s.tenant_id   = e.tenant_id
             AND s.entity_type = 'organization'
             AND s.entity_id   = e.id
             AND s.direction   = 'outbound'
      WHERE  e.tenant_id = p_tenant_id
      AND    (s.last_synced_at IS NULL OR e.updated_at > s.last_synced_at)
      ORDER  BY e.updated_at ASC
      LIMIT  p_limit;
  ELSE
    RAISE EXCEPTION 'Unsupported entity_type for zoho_crm_outbound_drift_candidates: %', p_entity_type;
  END IF;
END;
$$;

COMMENT ON FUNCTION zoho_crm_outbound_drift_candidates IS
  'Returns members/organizations whose updated_at is newer than the last successful outbound Zoho CRM sync, oldest first. Used by the outbound reconcile cron.';
