-- LMIC country list per tenant (task #607)
--
-- Stores the set of ISO-3166-1 alpha-2 country codes that a given tenant
-- considers "LMIC" for analytics purposes. The dashboard widget builder
-- exposes a `lmic` filter operator that, at query time, expands to
-- "country IN (codes for this tenant)" — so editing this table is
-- reflected in widget results immediately, without rewriting any widget
-- configurations.
--
-- The first time a tenant opens the LMIC settings page (or the API is
-- queried for an unseeded tenant) the API seeds the table from the
-- World Bank LMIC list defined in shared/lmicCountries.js.
--
-- Note: tenant_id has no FK to tenant(id) — single-tenant deployments
-- have no tenant table — but the column is still required so multi-
-- tenant deployments stay properly scoped.

CREATE TABLE IF NOT EXISTS tenant_lmic_country (
  tenant_id    UUID         NOT NULL,
  country_code VARCHAR(2)   NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, country_code),
  CONSTRAINT tenant_lmic_country_code_format CHECK (country_code ~ '^[A-Z]{2}$')
);

CREATE INDEX IF NOT EXISTS idx_tenant_lmic_country_tenant
  ON tenant_lmic_country(tenant_id);
