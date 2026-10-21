-- Task 5226. Apply only after approval. Server-only CAS and private object ledger.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS system_settings_badge_instructions_singleton
ON public.system_settings (tenant_id)
WHERE setting_key = 'tenant_badge_instructions';

CREATE TABLE IF NOT EXISTS public.badge_instruction_object (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  path text NOT NULL UNIQUE,
  filename text NOT NULL,
  size integer NOT NULL CHECK (size BETWEEN 1 AND 2097152),
  state text NOT NULL CHECK (state IN ('pending', 'current', 'deleting', 'garbage', 'cleaned')),
  deletion_backup text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.badge_instruction_object ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.badge_instruction_object FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.badge_instruction_object TO service_role;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('badge-instructions', 'badge-instructions', false, 2097152, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 2097152,
  allowed_mime_types = ARRAY['application/pdf'];

-- RESTRICTIVE policies also defeat an existing permissive "all tenant files"
-- policy. Only the service-role server may access these objects or settings.
DROP POLICY IF EXISTS badge_instructions_private ON storage.objects;
CREATE POLICY badge_instructions_private ON storage.objects AS RESTRICTIVE
FOR ALL TO anon, authenticated
USING (bucket_id <> 'badge-instructions')
WITH CHECK (bucket_id <> 'badge-instructions');
DROP POLICY IF EXISTS badge_instructions_server_only ON public.system_settings;
CREATE POLICY badge_instructions_server_only ON public.system_settings AS RESTRICTIVE
FOR ALL TO anon, authenticated
USING (setting_key <> 'tenant_badge_instructions')
WITH CHECK (setting_key <> 'tenant_badge_instructions');

CREATE OR REPLACE FUNCTION public.guard_badge_instruction_setting()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF ((TG_OP <> 'INSERT' AND OLD.setting_key = 'tenant_badge_instructions')
    OR (TG_OP <> 'DELETE' AND NEW.setting_key = 'tenant_badge_instructions'))
    AND current_setting('app.badge_instructions_write', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Badge instructions require their dedicated endpoint' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_badge_instruction_setting ON public.system_settings;
CREATE TRIGGER guard_badge_instruction_setting BEFORE INSERT OR UPDATE OR DELETE
ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.guard_badge_instruction_setting();

-- A single server-only RPC owns reservations, CAS transitions and cleanup
-- acknowledgement. The tenant row serializes even the initial absent setting.
CREATE OR REPLACE FUNCTION public.badge_instructions_mutate(
  p_tenant_id uuid, p_action text, p_revision text DEFAULT NULL,
  p_object_id uuid DEFAULT NULL, p_filename text DEFAULT NULL,
  p_size integer DEFAULT NULL, p_mode text DEFAULT NULL, p_backup text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_setting public.system_settings%ROWTYPE;
  v_object public.badge_instruction_object%ROWTYPE;
  v_value jsonb;
  v_used bigint;
  v_limit numeric;
  v_plan text;
  v_revision text;
BEGIN
  SELECT storage_used_bytes, plan_code INTO v_used, v_plan
    FROM public.tenant WHERE id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tenant not found'; END IF;
  SELECT * INTO v_setting FROM public.system_settings
    WHERE tenant_id = p_tenant_id AND setting_key = 'tenant_badge_instructions';
  BEGIN v_value := v_setting.setting_value::jsonb;
  EXCEPTION WHEN OTHERS THEN v_value := NULL;
  END;
  v_value := coalesce(v_value, '{"mode":"standard","revision":null,"document":null}'::jsonb);
  IF jsonb_typeof(v_value) IS DISTINCT FROM 'object' THEN
    v_value := '{"mode":"standard","revision":null,"document":null}'::jsonb;
  ELSIF jsonb_typeof(v_value->'revision') IS DISTINCT FROM 'string' THEN
    v_value := jsonb_set(v_value, '{revision}', 'null'::jsonb);
  END IF;

  -- A durable claim keeps the last working config and a private recovery copy
  -- until physical deletion succeeds. Other mutations cannot race this claim.
  IF p_action IN ('begin_delete', 'finish_delete') THEN
    IF (v_value->>'revision') IS DISTINCT FROM p_revision THEN
      RAISE EXCEPTION 'Badge instructions changed; reload and try again' USING ERRCODE = '40001';
    END IF;
    SELECT * INTO v_object FROM public.badge_instruction_object
      WHERE tenant_id = p_tenant_id AND id::text = v_value->'document'->>'id'
      AND state IN ('current', 'deleting') FOR UPDATE;
    IF NOT FOUND THEN
      IF p_action = 'begin_delete' AND v_value->'document' = 'null'::jsonb THEN RETURN v_value; END IF;
      RAISE EXCEPTION 'No owned PDF to delete' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'begin_delete' THEN
      IF v_object.state = 'current' THEN
        IF p_backup IS NULL OR length(p_backup) > 2796204
          OR octet_length(decode(p_backup, 'base64')) <> v_object.size THEN
          RAISE EXCEPTION 'Deletion requires a verified recovery copy' USING ERRCODE = '22023';
        END IF;
        UPDATE public.badge_instruction_object SET state = 'deleting', deletion_backup = p_backup
          WHERE id = v_object.id;
      END IF;
      RETURN v_value;
    ELSE
      IF v_object.state <> 'deleting' THEN
        RAISE EXCEPTION 'Deletion claim required' USING ERRCODE = '40001';
      END IF;
      UPDATE public.badge_instruction_object SET state = 'cleaned', deletion_backup = NULL WHERE id = v_object.id;
      UPDATE public.tenant SET storage_used_bytes = greatest(0, coalesce(storage_used_bytes, 0) - v_object.size)
        WHERE id = p_tenant_id;
      v_value := jsonb_build_object('mode', 'standard', 'document', NULL, 'revision', gen_random_uuid()::text);
      PERFORM set_config('app.badge_instructions_write', 'yes', true);
      UPDATE public.system_settings SET setting_value = v_value::text WHERE id = v_setting.id;
      PERFORM set_config('app.badge_instructions_write', '', true);
      RETURN v_value;
    END IF;
  END IF;
  IF p_action IN ('prepare', 'upload', 'mode', 'delete') AND EXISTS (
    SELECT 1 FROM public.badge_instruction_object WHERE tenant_id = p_tenant_id AND state = 'deleting'
  ) THEN
    RAISE EXCEPTION 'Deletion is pending; retry deletion to recover' USING ERRCODE = '40001';
  END IF;

  IF p_action = 'prepare' THEN
    IF (v_value->>'revision') IS DISTINCT FROM p_revision THEN
      RAISE EXCEPTION 'Badge instructions changed; reload and try again' USING ERRCODE = '40001';
    END IF;
    IF p_object_id IS NULL OR p_size IS NULL OR p_size NOT BETWEEN 1 AND 2097152
      OR p_filename IS NULL OR length(p_filename) > 200 OR p_filename !~* '\.pdf$' THEN
      RAISE EXCEPTION 'Invalid PDF metadata' USING ERRCODE = '22023';
    END IF;
    SELECT (quotas->>'storage_mb')::numeric * 1048576 INTO v_limit
      FROM public.plan WHERE code = coalesce(v_plan, 'free');
    IF v_limit IS NOT NULL AND coalesce(v_used, 0) + p_size > v_limit THEN
      RAISE EXCEPTION 'Tenant storage quota exceeded' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO public.badge_instruction_object(id, tenant_id, path, filename, size, state)
      VALUES (p_object_id, p_tenant_id, p_tenant_id::text || '/' || p_object_id::text || '.pdf',
        p_filename, p_size, 'pending');
    UPDATE public.tenant SET storage_used_bytes = coalesce(storage_used_bytes, 0) + p_size
      WHERE id = p_tenant_id;
    RETURN v_value;
  ELSIF p_action = 'abandon' THEN
    -- Keep tombstones: an expired request can finish its storage upload after
    -- cleanup. Re-reserve bytes and retry removal, never lose that object.
    SELECT * INTO v_object FROM public.badge_instruction_object
      WHERE id = p_object_id AND tenant_id = p_tenant_id FOR UPDATE;
    IF v_object.state = 'cleaned' THEN
      UPDATE public.tenant SET storage_used_bytes = coalesce(storage_used_bytes, 0) + v_object.size
        WHERE id = p_tenant_id;
    END IF;
    UPDATE public.badge_instruction_object SET state = 'garbage'
      WHERE id = p_object_id AND tenant_id = p_tenant_id AND state IN ('pending', 'cleaned');
    RETURN v_value;
  ELSIF p_action = 'cleanup_ack' THEN
    UPDATE public.badge_instruction_object SET state = 'cleaned'
      WHERE id = p_object_id AND tenant_id = p_tenant_id AND state = 'garbage'
      RETURNING * INTO v_object;
    IF FOUND THEN
      UPDATE public.tenant SET storage_used_bytes = greatest(0, coalesce(storage_used_bytes, 0) - v_object.size)
        WHERE id = p_tenant_id;
    END IF;
    RETURN v_value;
  ELSIF p_action = 'expire' THEN
    -- Pending requests never become current after the lease expires. Keep
    -- failed cleanup rows durable so the next admin request can retry.
    UPDATE public.badge_instruction_object SET state = 'garbage'
      WHERE tenant_id = p_tenant_id AND state = 'pending' AND created_at < now() - interval '1 hour';
    RETURN v_value;
  END IF;

  IF p_action NOT IN ('upload', 'mode') THEN
    RAISE EXCEPTION 'Invalid action' USING ERRCODE = '22023';
  END IF;
  IF (v_value->>'revision') IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'Badge instructions changed; reload and try again' USING ERRCODE = '40001';
  END IF;
  IF p_action = 'upload' THEN
    SELECT * INTO v_object FROM public.badge_instruction_object
      WHERE id = p_object_id AND tenant_id = p_tenant_id AND state = 'pending'
      AND created_at >= now() - interval '1 hour' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload expired; upload again' USING ERRCODE = '40001'; END IF;
    UPDATE public.badge_instruction_object SET state = 'garbage'
      WHERE tenant_id = p_tenant_id AND state = 'current';
    UPDATE public.badge_instruction_object SET state = 'current' WHERE id = p_object_id;
    v_value := jsonb_build_object('mode', coalesce(v_value->>'mode', 'standard'),
      'document', jsonb_build_object('id', v_object.id, 'path', v_object.path,
        'filename', v_object.filename, 'size', v_object.size));
  ELSIF p_action = 'mode' THEN
    IF p_mode IS NULL OR p_mode NOT IN ('standard', 'pdf') THEN
      RAISE EXCEPTION 'Invalid mode' USING ERRCODE = '22023';
    END IF;
    IF p_mode = 'pdf' AND NOT EXISTS (
      SELECT 1 FROM public.badge_instruction_object WHERE tenant_id = p_tenant_id
        AND id::text = v_value->'document'->>'id' AND state = 'current'
    ) THEN RAISE EXCEPTION 'Upload a valid PDF first' USING ERRCODE = '22023'; END IF;
    v_value := jsonb_set(v_value, '{mode}', to_jsonb(p_mode));
  END IF;
  v_revision := gen_random_uuid()::text;
  v_value := jsonb_set(v_value, '{revision}', to_jsonb(v_revision));
  PERFORM set_config('app.badge_instructions_write', 'yes', true);
  IF v_setting.id IS NULL THEN
    INSERT INTO public.system_settings(tenant_id, setting_key, setting_value)
      VALUES (p_tenant_id, 'tenant_badge_instructions', v_value::text);
  ELSE
    UPDATE public.system_settings SET setting_value = v_value::text WHERE id = v_setting.id;
  END IF;
  PERFORM set_config('app.badge_instructions_write', '', true);
  RETURN v_value;
END;
$$;
REVOKE ALL ON FUNCTION public.badge_instructions_mutate(uuid,text,text,uuid,text,integer,text,text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.badge_instructions_mutate(uuid,text,text,uuid,text,integer,text,text)
TO service_role;
COMMIT;
