BEGIN;

-- A tenant setting, not a submission-retention policy. Existing links are
-- deliberately untouched; changes are snapshotted only when a link is created.
CREATE UNIQUE INDEX IF NOT EXISTS form_submission_link_expiry_setting_unique
ON public.system_settings(tenant_id,setting_key)
WHERE setting_key='form_submission_link_expiry_days';

CREATE OR REPLACE FUNCTION public.validate_form_submission_link_expiry_setting()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.setting_key='form_submission_link_expiry_days' THEN
    IF NEW.tenant_id IS NULL OR NEW.setting_value IS NULL
      OR NEW.setting_value !~ '^[1-9][0-9]{0,2}$' THEN
      RAISE EXCEPTION 'Submission link expiry must be a whole number from 1 to 365 days' USING ERRCODE='23514';
    END IF;
    IF NEW.setting_value::integer > 365 THEN
      RAISE EXCEPTION 'Submission link expiry must be a whole number from 1 to 365 days' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validate_form_submission_link_expiry_setting() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS validate_form_submission_link_expiry_setting ON public.system_settings;
CREATE TRIGGER validate_form_submission_link_expiry_setting
BEFORE INSERT OR UPDATE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.validate_form_submission_link_expiry_setting();

CREATE OR REPLACE FUNCTION public.set_form_submission_link_expiry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE days_text text; days integer := 7;
BEGIN
  SELECT setting_value INTO days_text FROM public.system_settings
    WHERE tenant_id=NEW.tenant_id AND setting_key='form_submission_link_expiry_days';
  IF FOUND THEN
    IF days_text IS NULL OR days_text !~ '^[1-9][0-9]{0,2}$' THEN
      RAISE EXCEPTION 'Invalid submission link expiry setting' USING ERRCODE='23514';
    END IF;
    days := days_text::integer;
    IF days > 365 THEN RAISE EXCEPTION 'Invalid submission link expiry setting' USING ERRCODE='23514'; END IF;
  END IF;
  NEW.expires_at := now() + make_interval(days=>days);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.set_form_submission_link_expiry() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS set_form_submission_link_expiry ON public.form_alert_delivery;
CREATE TRIGGER set_form_submission_link_expiry BEFORE INSERT ON public.form_alert_delivery
FOR EACH ROW EXECUTE FUNCTION public.set_form_submission_link_expiry();
DROP TRIGGER IF EXISTS set_form_submission_link_expiry ON public.form_submission_forward;
CREATE TRIGGER set_form_submission_link_expiry BEFORE INSERT ON public.form_submission_forward
FOR EACH ROW EXECUTE FUNCTION public.set_form_submission_link_expiry();

NOTIFY pgrst,'reload schema';
COMMIT;
