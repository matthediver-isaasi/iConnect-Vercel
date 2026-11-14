BEGIN;
-- Keep both ordinary claim and explicit resend paths from acquiring authority
-- to send original submission emails for evidence-only amendment rows.
CREATE FUNCTION public.awards_guard_amendment_email_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.awards_amendment_application_id IS NOT NULL
    AND to_jsonb(NEW)->'submission_email_state'->>'status' IN ('pending','ready','processing') THEN
    RAISE EXCEPTION 'Award amendments cannot repeat original submission emails' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.awards_guard_amendment_email_claim() FROM PUBLIC,anon,authenticated,service_role;
-- Legacy schemas can lack the email lifecycle column. The generic JSON
-- projection above stays compatible; installing on all updates ensures that
-- a later column addition cannot accidentally bypass this guard.
CREATE TRIGGER awards_amendment_email_claim BEFORE INSERT OR UPDATE ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.awards_guard_amendment_email_claim();
COMMIT;
