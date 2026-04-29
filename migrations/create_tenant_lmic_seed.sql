-- LMIC seed marker per tenant (task #607)
--
-- Distinguishes "tenant has never had a list initialised" from "tenant
-- admin has intentionally saved an empty list". Without this marker the
-- API would silently re-seed defaults on the next read whenever the
-- list happens to be empty, undoing an intentional clear.
--
-- A single row per tenant is inserted the first time the LMIC settings
-- endpoint or dashboard query path seeds defaults; subsequent saves
-- (including saves of an empty list) leave the marker in place so the
-- list is treated as "user-managed" forever after.

CREATE TABLE IF NOT EXISTS tenant_lmic_seed (
  tenant_id  UUID         PRIMARY KEY,
  seeded_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
