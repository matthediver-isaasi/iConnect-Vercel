BEGIN;
CREATE INDEX awards_application_member ON public.awards_application(member_id) WHERE member_id IS NOT NULL;
CREATE INDEX assessment_appointment_member_owner ON public.assessment_appointment(member_id) WHERE member_id IS NOT NULL;
CREATE INDEX assessment_appointment_contact_owner ON public.assessment_appointment(contact_id) WHERE contact_id IS NOT NULL;
CREATE FUNCTION public.awards_guard_canonical_ownership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE owner uuid;
BEGIN
  IF TG_TABLE_NAME='form' AND to_jsonb(NEW)->'tenant_id' IS DISTINCT FROM to_jsonb(OLD)->'tenant_id' THEN
    IF EXISTS(SELECT 1 FROM public.awards_form_binding WHERE form_id=OLD.id AND tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
      RAISE EXCEPTION 'Award-linked form ownership cannot change'; END IF;
  ELSIF TG_TABLE_NAME='form_submission' AND
    (to_jsonb(NEW)->'tenant_id' IS DISTINCT FROM to_jsonb(OLD)->'tenant_id' OR to_jsonb(NEW)->'form_id' IS DISTINCT FROM to_jsonb(OLD)->'form_id') THEN
    IF EXISTS(SELECT 1 FROM public.awards_intake_capture WHERE submission_id=OLD.id)
      OR EXISTS(SELECT 1 FROM public.awards_application WHERE submission_id=OLD.id) THEN
      RAISE EXCEPTION 'Award submission ownership cannot change'; END IF;
  ELSIF TG_TABLE_NAME='member' THEN
    owner:=NEW.tenant_id;
    IF owner IS NULL THEN SELECT tenant_id INTO owner FROM public.organization WHERE id=NEW.organization_id; END IF;
    IF EXISTS(SELECT 1 FROM public.assessment_appointment WHERE member_id=OLD.id AND tenant_id IS DISTINCT FROM owner)
      OR EXISTS(SELECT 1 FROM public.awards_application WHERE member_id=OLD.id AND tenant_id IS DISTINCT FROM owner)
      OR EXISTS(SELECT 1 FROM public.awards_intake_capture WHERE member_id=OLD.id AND tenant_id IS DISTINCT FROM owner) THEN
      RAISE EXCEPTION 'Award-linked member ownership cannot change'; END IF;
  ELSIF TG_TABLE_NAME='organization_contact' THEN
    SELECT tenant_id INTO owner FROM public.organization WHERE id=NEW.organization_id;
    IF EXISTS(SELECT 1 FROM public.assessment_appointment WHERE contact_id=OLD.id AND tenant_id IS DISTINCT FROM owner) THEN
      RAISE EXCEPTION 'Judge contact ownership cannot change'; END IF;
  ELSIF TG_TABLE_NAME='organization' AND to_jsonb(NEW)->'tenant_id' IS DISTINCT FROM to_jsonb(OLD)->'tenant_id' THEN
    IF EXISTS(SELECT 1 FROM public.assessment_appointment a JOIN public.organization_contact c ON c.id=a.contact_id
      WHERE c.organization_id=OLD.id AND a.tenant_id IS DISTINCT FROM NEW.tenant_id)
      OR EXISTS(SELECT 1 FROM public.assessment_appointment a JOIN public.member m ON m.id=a.member_id
        WHERE m.organization_id=OLD.id AND m.tenant_id IS NULL AND a.tenant_id IS DISTINCT FROM NEW.tenant_id)
      OR EXISTS(SELECT 1 FROM public.awards_application a JOIN public.member m ON m.id=a.member_id
        WHERE m.organization_id=OLD.id AND m.tenant_id IS NULL AND a.tenant_id IS DISTINCT FROM NEW.tenant_id)
      OR EXISTS(SELECT 1 FROM public.awards_intake_capture a JOIN public.member m ON m.id=a.member_id
        WHERE m.organization_id=OLD.id AND m.tenant_id IS NULL AND a.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
      RAISE EXCEPTION 'Award-linked organisation ownership cannot change'; END IF;
  ELSIF TG_TABLE_NAME='event' AND to_jsonb(NEW)->'tenant_id' IS DISTINCT FROM to_jsonb(OLD)->'tenant_id' THEN
    IF EXISTS(SELECT 1 FROM public.awards_event_link WHERE event_id=OLD.id AND tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
      RAISE EXCEPTION 'Award-linked event ownership cannot change'; END IF;
  ELSIF TG_TABLE_NAME='complex_event' AND to_jsonb(NEW)->'tenant_id' IS DISTINCT FROM to_jsonb(OLD)->'tenant_id' THEN
    IF EXISTS(SELECT 1 FROM public.awards_event_link WHERE complex_event_id=OLD.id AND tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
      RAISE EXCEPTION 'Award-linked event ownership cannot change'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER awards_guard_canonical_ownership BEFORE UPDATE OF tenant_id ON public.form
  FOR EACH ROW EXECUTE FUNCTION public.awards_guard_canonical_ownership();
CREATE TRIGGER awards_guard_canonical_ownership BEFORE UPDATE OF tenant_id,form_id ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.awards_guard_canonical_ownership();
CREATE TRIGGER awards_guard_canonical_ownership BEFORE UPDATE OF tenant_id,organization_id ON public.member
  FOR EACH ROW EXECUTE FUNCTION public.awards_guard_canonical_ownership();
CREATE TRIGGER awards_guard_canonical_ownership BEFORE UPDATE OF organization_id ON public.organization_contact
  FOR EACH ROW EXECUTE FUNCTION public.awards_guard_canonical_ownership();
CREATE TRIGGER awards_guard_canonical_ownership BEFORE UPDATE OF tenant_id ON public.organization
  FOR EACH ROW EXECUTE FUNCTION public.awards_guard_canonical_ownership();
CREATE TRIGGER awards_guard_canonical_ownership BEFORE UPDATE OF tenant_id ON public.event
  FOR EACH ROW EXECUTE FUNCTION public.awards_guard_canonical_ownership();
CREATE TRIGGER awards_guard_canonical_ownership BEFORE UPDATE OF tenant_id ON public.complex_event
  FOR EACH ROW EXECUTE FUNCTION public.awards_guard_canonical_ownership();
REVOKE ALL ON FUNCTION public.awards_guard_canonical_ownership() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
