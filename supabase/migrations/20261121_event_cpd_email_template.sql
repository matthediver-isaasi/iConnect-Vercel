-- Extend the existing JSON configuration without changing PDF/ticket policy.
-- The trigger participates in the atomic replacement RPC's transaction and
-- locks the selected email row against concurrent edits/deletion until commit.
CREATE OR REPLACE FUNCTION public.validate_event_cpd_email_template_config()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_id text;
  v_locked uuid;
BEGIN
  IF NEW.config->'eventRule' ? 'email_template_id'
    AND jsonb_typeof(NEW.config->'eventRule'->'email_template_id') NOT IN ('null','string') THEN
    RAISE EXCEPTION 'invalid event email template reference';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(NEW.config->'ticketRules') t
    WHERE t.value->>'email_template_id' IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invalid ticket email template override: email selection is event-wide';
  END IF;
  v_id := NEW.config->'eventRule'->>'email_template_id';
  IF v_id IS NOT NULL THEN
    SELECT t.id INTO v_locked FROM public.email_template t
    WHERE t.tenant_id=NEW.tenant_id AND t.id::text=v_id
      AND t.category='events' AND t.is_active IS TRUE
      AND length(btrim(t.subject)) > 0 AND length(btrim(t.body)) > 0
    FOR SHARE;
    IF v_locked IS NULL THEN
      RAISE EXCEPTION 'invalid email template: select an active tenant-owned Events email template with a subject and body';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validate_event_cpd_email_template_config() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS validate_event_cpd_email_template_config ON public.event_cpd_certificate_config;
CREATE TRIGGER validate_event_cpd_email_template_config
BEFORE INSERT OR UPDATE ON public.event_cpd_certificate_config
FOR EACH ROW EXECUTE FUNCTION public.validate_event_cpd_email_template_config();