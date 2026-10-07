-- Member Group custom fields are independent of PreferenceField scopes.
-- Apply only to verified DEST after approval. No existing group data is changed.
ALTER TABLE public.member_group
  ADD COLUMN IF NOT EXISTS custom_field_values jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS member_group_custom_fields_setting_singleton
  ON public.system_settings (tenant_id)
  WHERE setting_key = 'member_group_custom_fields';

-- Raw definitions never belong in direct browser settings reads.
DROP POLICY IF EXISTS member_group_custom_fields_private ON public.system_settings;
CREATE POLICY member_group_custom_fields_private ON public.system_settings
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (setting_key IS DISTINCT FROM 'member_group_custom_fields')
  WITH CHECK (setting_key IS DISTINCT FROM 'member_group_custom_fields');

CREATE OR REPLACE FUNCTION public.save_member_group_custom_fields(
  p_tenant uuid, p_fields jsonb, p_revision integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prior jsonb;
  field jsonb;
  old_field jsonb;
BEGIN
  IF p_tenant IS NULL OR p_revision IS NULL OR p_revision < 0
     OR p_fields IS NULL OR jsonb_typeof(p_fields) <> 'array'
     OR jsonb_array_length(p_fields) > 50 THEN
    RAISE EXCEPTION 'Invalid field definitions' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('member-group-fields:' || p_tenant::text, 0));
  SELECT setting_value::jsonb INTO prior FROM public.system_settings
    WHERE tenant_id = p_tenant AND setting_key = 'member_group_custom_fields';
  IF coalesce((prior->>'revision')::integer, 0) <> p_revision THEN
    RAISE EXCEPTION 'Definitions changed' USING ERRCODE = '40001';
  END IF;
  IF (SELECT count(DISTINCT f->>'id') FROM jsonb_array_elements(p_fields) f) <> jsonb_array_length(p_fields) THEN
    RAISE EXCEPTION 'Duplicate IDs' USING ERRCODE = '22023';
  END IF;
  FOR field IN SELECT * FROM jsonb_array_elements(p_fields) LOOP
    IF field->>'id' IS NULL OR (field->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR length(trim(coalesce(field->>'name',''))) NOT BETWEEN 1 AND 120
      OR coalesce(field->>'type','') NOT IN ('text','textarea','number','date','select','boolean','email','url')
      OR jsonb_typeof(field->'show_on_detail') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(field->'choices') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid field' USING ERRCODE = '22023';
    END IF;
    SELECT f INTO old_field FROM jsonb_array_elements(coalesce(prior->'fields','[]')) f WHERE f->>'id' = field->>'id';
    IF old_field IS NOT NULL AND (
      old_field->>'type' IS DISTINCT FROM field->>'type'
      OR NOT ((field->'choices') @> (old_field->'choices'))
    ) THEN
      RAISE EXCEPTION 'Existing types and choices cannot be reinterpreted' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  -- Confirmed removal must erase values, not just hide them. The same
  -- transaction/tenant lock protects both definitions and the purge.
  UPDATE public.member_group g
  SET custom_field_values = (
    SELECT coalesce(jsonb_object_agg(v.key, v.value), '{}'::jsonb)
    FROM jsonb_each(g.custom_field_values) v
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(p_fields) f WHERE f->>'id' = v.key)
  )
  WHERE g.tenant_id = p_tenant AND EXISTS (
    SELECT 1 FROM jsonb_object_keys(g.custom_field_values) k
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_fields) f WHERE f->>'id' = k)
  );
  INSERT INTO public.system_settings(id, tenant_id, setting_key, setting_value)
    VALUES(gen_random_uuid(), p_tenant, 'member_group_custom_fields',
      jsonb_build_object('fields',p_fields,'revision',p_revision+1)::text)
    ON CONFLICT (tenant_id) WHERE setting_key = 'member_group_custom_fields'
    DO UPDATE SET setting_value = EXCLUDED.setting_value;
END;
$$;
REVOKE ALL ON FUNCTION public.save_member_group_custom_fields(uuid,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_member_group_custom_fields(uuid,jsonb,integer) TO service_role;

-- Serialize group writes against definition deletion. Unrelated updates must
-- preserve orphan values, but no subsequent explicit value save may submit them.
CREATE OR REPLACE FUNCTION public.guard_member_group_custom_values()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE defs jsonb; k text; v jsonb; f jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'Group tenant cannot change' USING ERRCODE = '22023';
    END IF;
    IF NEW.custom_field_values IS NOT DISTINCT FROM OLD.custom_field_values THEN RETURN NEW; END IF;
  END IF;
  IF NEW.custom_field_values IS NULL OR jsonb_typeof(NEW.custom_field_values) <> 'object'
    OR pg_column_size(NEW.custom_field_values) > 600000 THEN
    RAISE EXCEPTION 'Invalid custom values' USING ERRCODE = '22023';
  END IF;
  IF NEW.custom_field_values = '{}'::jsonb THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('member-group-fields:' || NEW.tenant_id::text, 0));
  SELECT setting_value::jsonb->'fields' INTO defs FROM public.system_settings
    WHERE tenant_id = NEW.tenant_id AND setting_key = 'member_group_custom_fields';
  FOR k,v IN SELECT * FROM jsonb_each(NEW.custom_field_values) LOOP
    SELECT x INTO f FROM jsonb_array_elements(coalesce(defs,'[]')) x WHERE x->>'id' = k;
    IF f IS NULL THEN RAISE EXCEPTION 'Unknown custom field' USING ERRCODE = '22023'; END IF;
    IF v = 'null'::jsonb OR v = '""'::jsonb THEN CONTINUE; END IF;
    IF (f->>'type' = 'number' AND jsonb_typeof(v) <> 'number')
      OR (f->>'type' = 'boolean' AND jsonb_typeof(v) <> 'boolean')
      OR (f->>'type' NOT IN ('number','boolean') AND jsonb_typeof(v) <> 'string')
      OR (f->>'type' = 'select' AND NOT (f->'choices' @> jsonb_build_array(v))) THEN
      RAISE EXCEPTION 'Invalid custom field value' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_member_group_custom_values() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_member_group_custom_values ON public.member_group;
CREATE TRIGGER guard_member_group_custom_values BEFORE INSERT OR UPDATE
  ON public.member_group FOR EACH ROW EXECUTE FUNCTION public.guard_member_group_custom_values();
