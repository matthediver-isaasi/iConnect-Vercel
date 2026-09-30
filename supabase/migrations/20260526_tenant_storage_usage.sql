-- Tenant cumulative storage usage tracking (Task #1027)
--
-- Adds a cumulative byte counter to `tenant` so plan-quota enforcement
-- (api/_lib/planQuota.js -> checkStorageQuota) and the admin "Plan & usage"
-- page can compare real usage against `plan.quotas.storage_mb`.
--
-- The counter is maintained incrementally by upload/delete endpoints via the
-- `increment_tenant_storage_bytes` RPC (atomic UPDATE...RETURNING). It can be
-- re-baselined at any time by scripts/recompute-tenant-storage.mjs which sums
-- the actual objects stored in Supabase Storage.
--
-- Idempotent — safe to re-run.

ALTER TABLE tenant
  ADD COLUMN IF NOT EXISTS storage_used_bytes BIGINT NOT NULL DEFAULT 0;

-- Clamp to >= 0 in case a buggy decrement underflows. We do not enforce
-- a CHECK constraint so the recompute script can write any baseline value.

CREATE OR REPLACE FUNCTION increment_tenant_storage_bytes(p_tenant_id UUID, p_delta BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_new BIGINT;
BEGIN
  UPDATE tenant
     SET storage_used_bytes = GREATEST(0, COALESCE(storage_used_bytes, 0) + p_delta)
   WHERE id = p_tenant_id
   RETURNING storage_used_bytes INTO v_new;
  RETURN v_new;
END;
$$;
