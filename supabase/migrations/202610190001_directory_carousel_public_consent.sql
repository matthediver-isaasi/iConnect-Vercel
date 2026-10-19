-- Explicit carousel-only consent. No existing source is opted in.
-- Apply only to the verified destination after rollout approval.
ALTER TABLE public.dynamic_directory
  ADD COLUMN IF NOT EXISTS public_carousel_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.dynamic_directory.public_carousel_enabled IS
  'Administrator-approved public Directory Carousel projection only; independent of activation, roles and legacy full-directory/embed access.';

-- New singleton keys only; no legacy SystemSettings identity changes.
CREATE UNIQUE INDEX IF NOT EXISTS directory_carousel_primary_consent_identity
  ON public.system_settings (tenant_id, setting_key)
  WHERE setting_key IN ('member_directory_public_carousel_enabled', 'org_directory_public_carousel_enabled');

-- Browser database roles must not bypass the server's administrator check.
-- Invoker security intentionally preserves current_user.
CREATE OR REPLACE FUNCTION public.guard_directory_carousel_consent()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_TABLE_NAME = 'system_settings' THEN
      IF (TG_OP <> 'INSERT' AND OLD.setting_key IN (
          'member_directory_public_carousel_enabled', 'org_directory_public_carousel_enabled'))
        OR (TG_OP <> 'DELETE' AND NEW.setting_key IN (
          'member_directory_public_carousel_enabled', 'org_directory_public_carousel_enabled')) THEN
        RAISE EXCEPTION 'Public carousel consent is server-managed' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF (TG_OP <> 'INSERT' AND OLD.public_carousel_enabled IS TRUE)
        OR (TG_OP <> 'DELETE' AND NEW.public_carousel_enabled IS TRUE)
        OR (TG_OP = 'UPDATE' AND NEW.public_carousel_enabled IS DISTINCT FROM OLD.public_carousel_enabled) THEN
        RAISE EXCEPTION 'Public carousel sources are server-managed' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_directory_carousel_consent() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS directory_carousel_consent_guard ON public.dynamic_directory;
CREATE TRIGGER directory_carousel_consent_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.dynamic_directory
  FOR EACH ROW EXECUTE FUNCTION public.guard_directory_carousel_consent();
DROP TRIGGER IF EXISTS directory_carousel_consent_guard ON public.system_settings;
CREATE TRIGGER directory_carousel_consent_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.guard_directory_carousel_consent();
