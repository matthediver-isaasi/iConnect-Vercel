-- Private sidecar only. Never add billing columns to browser-readable owners.
-- No backfill, legacy-address rewrite, financial evidence or provider changes.
BEGIN;

-- This migration replaces an unapplied owner-column proposal. Stop rather than
-- leave private billing copies exposed through inherited owner-table grants.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name IN ('member','organization','organization_group')
      AND column_name IN ('invoicing_address_line1','invoicing_address_line2',
        'invoicing_city','invoicing_region','invoicing_postal_code','invoicing_country')
  ) THEN
    RAISE EXCEPTION 'Private invoicing address migration blocked: preexisting owner billing columns require a separately reviewed privacy/data migration';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.invoicing_address_private (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  owner_type text NOT NULL CHECK (owner_type IN ('member', 'organization', 'organization_group')),
  owner_id uuid NOT NULL,
  invoicing_address_line1 text CHECK (length(invoicing_address_line1) <= 255),
  invoicing_address_line2 text CHECK (length(invoicing_address_line2) <= 255),
  invoicing_city text CHECK (length(invoicing_city) <= 100),
  invoicing_region text CHECK (length(invoicing_region) <= 100),
  invoicing_postal_code text CHECK (length(invoicing_postal_code) <= 32),
  invoicing_country text CHECK (length(invoicing_country) <= 50),
  PRIMARY KEY (tenant_id, owner_type, owner_id)
);
ALTER TABLE public.invoicing_address_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoicing_address_private FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoicing_address_private FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoicing_address_private TO service_role;

CREATE OR REPLACE FUNCTION public.validate_private_invoicing_address_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE owner_tenant uuid;
BEGIN
  IF NEW.owner_type NOT IN ('member','organization','organization_group') THEN
    RAISE EXCEPTION 'Unsupported invoicing address owner' USING ERRCODE='23514';
  END IF;
  EXECUTE format('SELECT tenant_id FROM public.%I WHERE id=$1 FOR SHARE', NEW.owner_type)
    INTO owner_tenant USING NEW.owner_id;
  IF owner_tenant IS NULL OR owner_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Invoicing address owner must exist in the same tenant' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validate_private_invoicing_address_owner() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS validate_private_invoicing_address_owner ON public.invoicing_address_private;
CREATE TRIGGER validate_private_invoicing_address_owner BEFORE INSERT OR UPDATE
ON public.invoicing_address_private FOR EACH ROW EXECUTE FUNCTION public.validate_private_invoicing_address_owner();

-- Atomic partial patch: concurrent edits to different fields do not erase each
-- other. Execution and table privileges are service-only; API authorizes owner.
CREATE OR REPLACE FUNCTION public.patch_private_invoicing_address(
  p_tenant_id uuid, p_owner_type text, p_owner_id uuid, p_address jsonb
) RETURNS SETOF public.invoicing_address_private
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF jsonb_typeof(p_address) IS DISTINCT FROM 'object'
    OR EXISTS (SELECT FROM jsonb_each(p_address) AS v(key,value)
      WHERE key NOT IN ('invoicing_address_line1','invoicing_address_line2','invoicing_city',
        'invoicing_region','invoicing_postal_code','invoicing_country')
      OR jsonb_typeof(value) NOT IN ('string','null')) THEN
    RAISE EXCEPTION 'Invalid invoicing address patch' USING ERRCODE='23514';
  END IF;
  RETURN QUERY INSERT INTO public.invoicing_address_private AS saved
    (tenant_id, owner_type, owner_id, invoicing_address_line1, invoicing_address_line2,
      invoicing_city, invoicing_region, invoicing_postal_code, invoicing_country)
  VALUES (p_tenant_id,p_owner_type,p_owner_id,
    nullif(btrim(p_address->>'invoicing_address_line1'),''),
    nullif(btrim(p_address->>'invoicing_address_line2'),''),
    nullif(btrim(p_address->>'invoicing_city'),''),
    nullif(btrim(p_address->>'invoicing_region'),''),
    nullif(btrim(p_address->>'invoicing_postal_code'),''),
    nullif(btrim(p_address->>'invoicing_country'),''))
  ON CONFLICT (tenant_id,owner_type,owner_id) DO UPDATE SET
    invoicing_address_line1=CASE WHEN p_address ? 'invoicing_address_line1' THEN EXCLUDED.invoicing_address_line1 ELSE saved.invoicing_address_line1 END,
    invoicing_address_line2=CASE WHEN p_address ? 'invoicing_address_line2' THEN EXCLUDED.invoicing_address_line2 ELSE saved.invoicing_address_line2 END,
    invoicing_city=CASE WHEN p_address ? 'invoicing_city' THEN EXCLUDED.invoicing_city ELSE saved.invoicing_city END,
    invoicing_region=CASE WHEN p_address ? 'invoicing_region' THEN EXCLUDED.invoicing_region ELSE saved.invoicing_region END,
    invoicing_postal_code=CASE WHEN p_address ? 'invoicing_postal_code' THEN EXCLUDED.invoicing_postal_code ELSE saved.invoicing_postal_code END,
    invoicing_country=CASE WHEN p_address ? 'invoicing_country' THEN EXCLUDED.invoicing_country ELSE saved.invoicing_country END
  RETURNING saved.*;
END $$;
REVOKE ALL ON FUNCTION public.patch_private_invoicing_address(uuid,text,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patch_private_invoicing_address(uuid,text,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_private_invoicing_address()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id THEN
      RETURN NULL;
    END IF;
  END IF;
  DELETE FROM public.invoicing_address_private
    WHERE owner_type=TG_TABLE_NAME AND owner_id=OLD.id AND tenant_id=OLD.tenant_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.cleanup_private_invoicing_address() FROM PUBLIC, anon, authenticated;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['member','organization','organization_group'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS cleanup_private_invoicing_address ON public.%I',t);
    EXECUTE format('CREATE TRIGGER cleanup_private_invoicing_address AFTER DELETE OR UPDATE OF tenant_id ON public.%I FOR EACH ROW EXECUTE FUNCTION public.cleanup_private_invoicing_address()',t);
  END LOOP;
END $$;

-- Anonymization clears personal sidecar PII, not frozen accounting snapshots.
CREATE OR REPLACE FUNCTION public.anonymize_private_invoicing_address()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.email = 'deleted_' || NEW.id::text || '@deleted.local' THEN
    DELETE FROM public.invoicing_address_private WHERE owner_type='member'
      AND owner_id=NEW.id AND tenant_id=OLD.tenant_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.anonymize_private_invoicing_address() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS anonymize_private_invoicing_address ON public.member;
CREATE TRIGGER anonymize_private_invoicing_address AFTER UPDATE OF email ON public.member
FOR EACH ROW EXECUTE FUNCTION public.anonymize_private_invoicing_address();
COMMIT;
