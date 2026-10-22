-- Foundation only: no backfill, provider writes, snapshot updates or RLS grants.
-- Each record owns its own address. Keep organization.invoicing_address intact.
BEGIN;

-- STOP rather than exposing private billing data through inherited table-wide
-- browser grants. API response redaction is not a database access boundary.
-- A separate reviewed storage/access change is required on such installations.
DO $privacy$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['member','organization','organization_group'] LOOP
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname=r)
        AND has_table_privilege(r,format('public.%I',t),'SELECT') THEN
        RAISE EXCEPTION 'Private invoicing address rollout blocked: browser role % has table-wide SELECT on %. Review protected storage/access before adding columns.',r,t;
      END IF;
    END LOOP;
    IF EXISTS (SELECT FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=format('public.%I',t)::regclass AND a.grantee=0 AND a.privilege_type='SELECT') THEN
      RAISE EXCEPTION 'Private invoicing address rollout blocked: PUBLIC has SELECT on %',t;
    END IF;
  END LOOP;
END $privacy$;

ALTER TABLE public.member
  ADD COLUMN IF NOT EXISTS invoicing_address_line1 text,
  ADD COLUMN IF NOT EXISTS invoicing_address_line2 text,
  ADD COLUMN IF NOT EXISTS invoicing_city text,
  ADD COLUMN IF NOT EXISTS invoicing_region text,
  ADD COLUMN IF NOT EXISTS invoicing_postal_code text,
  ADD COLUMN IF NOT EXISTS invoicing_country text;

ALTER TABLE public.organization
  ADD COLUMN IF NOT EXISTS invoicing_address_line1 text,
  ADD COLUMN IF NOT EXISTS invoicing_address_line2 text,
  ADD COLUMN IF NOT EXISTS invoicing_city text,
  ADD COLUMN IF NOT EXISTS invoicing_region text,
  ADD COLUMN IF NOT EXISTS invoicing_postal_code text,
  ADD COLUMN IF NOT EXISTS invoicing_country text;

ALTER TABLE public.organization_group
  ADD COLUMN IF NOT EXISTS invoicing_address_line1 text,
  ADD COLUMN IF NOT EXISTS invoicing_address_line2 text,
  ADD COLUMN IF NOT EXISTS invoicing_city text,
  ADD COLUMN IF NOT EXISTS invoicing_region text,
  ADD COLUMN IF NOT EXISTS invoicing_postal_code text,
  ADD COLUMN IF NOT EXISTS invoicing_country text;

COMMIT;
