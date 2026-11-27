-- Apply only with rollout approval. No tenant configuration rows are changed.
BEGIN;

-- Only this new key is constrained; legacy settings identities stay unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS system_settings_biography_helper_singleton
  ON public.system_settings (tenant_id)
  WHERE setting_key = 'professional_biography_helper_text';

-- Authenticated portal users use the tenant-scoped read API. A restrictive
-- policy defeats any older permissive settings policy.
DROP POLICY IF EXISTS biography_helper_server_only ON public.system_settings;
CREATE POLICY biography_helper_server_only ON public.system_settings AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (setting_key <> 'professional_biography_helper_text')
  WITH CHECK (setting_key <> 'professional_biography_helper_text');

-- Also protect writes when legacy installations have not enabled RLS.
-- Invoker security preserves the database role used by the request.
CREATE OR REPLACE FUNCTION public.guard_biography_helper_setting()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') AND (
    (TG_OP <> 'INSERT' AND OLD.setting_key = 'professional_biography_helper_text')
    OR (TG_OP <> 'DELETE' AND NEW.setting_key = 'professional_biography_helper_text')
  ) THEN
    RAISE EXCEPTION 'Biography helper text is server-managed' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_biography_helper_setting() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS biography_helper_setting_guard ON public.system_settings;
CREATE TRIGGER biography_helper_setting_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.guard_biography_helper_setting();

COMMIT;
