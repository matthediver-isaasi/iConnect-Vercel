-- Track redirect ownership without guessing which tenant owns legacy rows.
-- Existing unowned rows remain NULL and are therefore invisible to all
-- tenant-scoped redirect reads. Administrators must recreate or explicitly
-- assign those rows after reviewing their provenance.
BEGIN;

DO $$
DECLARE
  tenant_id_type text;
BEGIN
  IF to_regclass('public.redirect_mapping') IS NULL THEN
    -- Fresh databases created from shared/schema.ts already have this contract.
    RETURN;
  END IF;

  IF to_regclass('public.tenant') IS NULL THEN
    RAISE EXCEPTION 'tenant table is required before redirect_mapping can be tenant-scoped';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.redirect_mapping'::regclass
      AND attname = 'tenant_id'
      AND NOT attisdropped
  ) THEN
    -- Match tenant.id on both UUID production databases and older text-based
    -- schema snapshots. Never infer/backfill ownership from another column.
    SELECT format_type(a.atttypid, a.atttypmod)
      INTO tenant_id_type
    FROM pg_attribute a
    WHERE a.attrelid = 'public.tenant'::regclass
      AND a.attname = 'id'
      AND NOT a.attisdropped;

    IF tenant_id_type IS NULL THEN
      RAISE EXCEPTION 'tenant.id is required before redirect_mapping can be tenant-scoped';
    END IF;

    EXECUTE format(
      'ALTER TABLE public.redirect_mapping ADD COLUMN tenant_id %s',
      tenant_id_type
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.redirect_mapping'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.tenant'::regclass
      AND c.conkey = ARRAY[
        (SELECT attnum
         FROM pg_attribute
         WHERE attrelid = 'public.redirect_mapping'::regclass
           AND attname = 'tenant_id'
           AND NOT attisdropped)
      ]::smallint[]
  ) THEN
    ALTER TABLE public.redirect_mapping
      ADD CONSTRAINT redirect_mapping_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenant(id);
  END IF;

  CREATE INDEX IF NOT EXISTS idx_redirect_mapping_tenant_id
    ON public.redirect_mapping (tenant_id);

  CREATE INDEX IF NOT EXISTS idx_redirect_mapping_active_priority
    ON public.redirect_mapping (is_active, priority)
    WHERE is_active = true;
END $$;

COMMIT;