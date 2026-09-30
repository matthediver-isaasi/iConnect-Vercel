-- Unlimited plan for existing tenants (Task #1167)
--
-- Usage plans (free / starter / growth / enterprise) were introduced with
-- member / event / storage / email quotas. Existing tenants were backfilled to
-- `plan_code='free'`, silently throttling organisations that previously had no
-- limits at all.
--
-- This migration introduces a dedicated `unlimited` plan that reproduces the
-- pre-plans behaviour (no quotas of any kind) and moves every CURRENT tenant
-- onto it. The quota engine already treats a null/missing quota value as
-- "unlimited" (see api/_lib/planQuota.js), so this is purely data:
--   (a) a `plan` row with all-null quotas, and
--   (b) a backfill of `tenant.plan_code` for the pre-existing tenant cohort.
--
-- The unlimited plan is NOT self-serve (must not appear as a purchasable /
-- upgrade option) and has no Stripe price.
--
-- IMPORTANT — rerun safety: the backfill must NOT convert tenants created
-- AFTER this migration first runs (new tenants must keep defaulting to `free`).
-- We persist a singleton "first run" marker row that is written exactly once,
-- INDEPENDENT of how many tenants exist (including zero). Cohort capture is
-- gated off that marker, not off the tenant/cohort row count, so:
--   * first run captures whatever tenants exist at that moment (even none), and
--   * every later rerun finds the marker present and captures nothing — tenants
--     created after the first run are never added to the cohort or migrated.
--
-- All statements idempotent — safe to re-run with no double effects.

-- ---------------------------------------------------------------------------
-- 1. Add the unlimited plan to the catalog (all quotas null = unlimited)
-- ---------------------------------------------------------------------------
INSERT INTO plan (code, name, is_self_serve, quotas, display_order, display_price, description) VALUES
  ('unlimited', 'Unlimited', FALSE,
    '{"members":null,"events_per_month":null,"storage_mb":null,"emails_per_month":null,"custom_domain":true}'::jsonb,
    5, 'Custom', 'Legacy organisations with no usage limits.')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Persisted first-run marker + cohort snapshot tables
-- ---------------------------------------------------------------------------
-- Singleton marker: a single row whose existence means "first run completed".
-- Independent of tenant count, so the zero-tenants-on-first-run edge case is
-- handled correctly.
CREATE TABLE IF NOT EXISTS unlimited_plan_backfill_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  first_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS unlimited_plan_backfill_cohort (
  tenant_id UUID PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 3. Capture the pre-existing tenant cohort exactly once
-- ---------------------------------------------------------------------------
-- Gated off the marker (NOT off tenant/cohort row count). Runs BEFORE the
-- marker is written, so it only fires on the genuine first run. On a first run
-- with zero tenants this captures nothing yet still arms the marker below.
INSERT INTO unlimited_plan_backfill_cohort (tenant_id)
SELECT id FROM tenant
WHERE NOT EXISTS (SELECT 1 FROM unlimited_plan_backfill_state)
ON CONFLICT (tenant_id) DO NOTHING;

-- Arm the marker. Written once even when no tenants existed at first run, so
-- subsequent reruns never re-capture later-created tenants.
INSERT INTO unlimited_plan_backfill_state (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Move only the snapshotted (pre-existing) tenants onto the unlimited plan
-- ---------------------------------------------------------------------------
UPDATE tenant t
SET plan_code = 'unlimited'
FROM unlimited_plan_backfill_cohort c
WHERE t.id = c.tenant_id
  AND t.plan_code IS DISTINCT FROM 'unlimited';
