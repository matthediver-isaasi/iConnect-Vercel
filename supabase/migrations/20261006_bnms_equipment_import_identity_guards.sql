-- Database-enforced identities for the pinned BNMS Equipment Register import.
-- The trigger resolves object keys at write time, so this migration is safe to
-- apply before or after the tenant-specific objects have been created and does
-- not depend on generated object UUIDs.
CREATE OR REPLACE FUNCTION public.guard_bnms_equipment_import_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_object_key text;
  v_identity text;
BEGIN
  IF NEW.tenant_id <> 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
     OR NEW.archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT definition.object_key
  INTO v_object_key
  FROM public.custom_object_definition definition
  WHERE definition.id = NEW.custom_object_id
    AND definition.tenant_id = NEW.tenant_id;

  IF v_object_key IN ('equipment_register', 'equipment_model') THEN
    v_identity := NEW.data->>'source_identity';
  ELSIF v_object_key = 'equipment_type' THEN
    v_identity := NEW.data->>'name';
  ELSE
    RETURN NEW;
  END IF;

  IF v_identity IS NULL OR v_identity = '' THEN
    RAISE EXCEPTION 'BNMS % import identity is required', v_object_key
      USING ERRCODE = '23514', CONSTRAINT = 'bnms_equipment_import_identity_required';
  END IF;

  -- Serialize contenders for the same tenant/object/identity. Unlike a plain
  -- pre-insert lookup, the lock closes the concurrent-plan race even though
  -- the stable identity lives inside JSONB.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW.tenant_id::text || '|' || NEW.custom_object_id::text || '|' || v_identity,
      4154
    )
  );

  IF EXISTS (
    SELECT 1
    FROM public.custom_object_record existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.custom_object_id = NEW.custom_object_id
      AND existing.archived_at IS NULL
      AND existing.id <> NEW.id
      AND (
        (v_object_key IN ('equipment_register', 'equipment_model')
          AND existing.data->>'source_identity' = v_identity)
        OR
        (v_object_key = 'equipment_type'
          AND existing.data->>'name' = v_identity)
      )
  ) THEN
    RAISE EXCEPTION 'BNMS % import identity already exists', v_object_key
      USING ERRCODE = '23505', CONSTRAINT = 'bnms_equipment_import_identity_unique';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bnms_equipment_import_identity_guard
  ON public.custom_object_record;
CREATE TRIGGER bnms_equipment_import_identity_guard
  BEFORE INSERT OR UPDATE OF tenant_id, custom_object_id, data, archived_at
  ON public.custom_object_record
  FOR EACH ROW EXECUTE FUNCTION public.guard_bnms_equipment_import_identity();