-- Explicit member confirmation only. No backfill or email-based member lookup.
CREATE TABLE IF NOT EXISTS public.survey_invitation_attendee (
  entitlement_id uuid PRIMARY KEY REFERENCES public.certificate_survey_entitlement(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  booking_fingerprint text NOT NULL CHECK (booking_fingerprint ~ '^[a-f0-9]{64}$'),
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.survey_invitation_attendee ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.survey_invitation_attendee FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.survey_invitation_attendee FROM service_role;
GRANT SELECT ON public.survey_invitation_attendee TO service_role;

-- Monotonic fences survive change-and-revert, revoke-and-reopen and deletion
-- of a prior association. Captured HTTP state can never restore that authority.
ALTER TABLE public.booking ADD COLUMN IF NOT EXISTS survey_invitation_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.complex_event_booking ADD COLUMN IF NOT EXISTS survey_invitation_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.member ADD COLUMN IF NOT EXISTS survey_invitation_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.certificate_survey_entitlement ADD COLUMN IF NOT EXISTS survey_invitation_revision bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION public.bump_survey_invitation_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.survey_invitation_revision := OLD.survey_invitation_revision + 1;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.bump_survey_invitation_revision() FROM PUBLIC, anon, authenticated;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['booking','complex_event_booking','member','certificate_survey_entitlement'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS survey_invitation_revision ON public.%I', tab);
    EXECUTE format('CREATE TRIGGER survey_invitation_revision BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.bump_survey_invitation_revision()', tab);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.invalidate_survey_invitation_attendee()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME IN ('booking', 'complex_event_booking') THEN
    DELETE FROM public.survey_invitation_attendee a
      USING public.certificate_survey_entitlement e
      WHERE a.entitlement_id = e.id AND e.booking_id = OLD.id
        AND e.booking_source = CASE WHEN TG_TABLE_NAME = 'booking' THEN 'standard' ELSE 'complex' END;
  ELSIF TG_TABLE_NAME = 'member' THEN
    IF TG_OP = 'DELETE' OR OLD.email IS DISTINCT FROM NEW.email
      OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR OLD.login_enabled IS DISTINCT FROM NEW.login_enabled
      OR OLD.membership_paused IS DISTINCT FROM NEW.membership_paused THEN
      DELETE FROM public.survey_invitation_attendee WHERE member_id = OLD.id;
    END IF;
  ELSE
    -- Expiry extensions for resends do not invalidate explicit confirmation.
    IF TG_OP = 'DELETE' OR OLD.recipient_email IS DISTINCT FROM NEW.recipient_email
      OR OLD.booking_id IS DISTINCT FROM NEW.booking_id
      OR OLD.booking_source IS DISTINCT FROM NEW.booking_source
      OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR OLD.assignment_id IS DISTINCT FROM NEW.assignment_id
      OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
      OR OLD.completed_at IS DISTINCT FROM NEW.completed_at THEN
      DELETE FROM public.survey_invitation_attendee WHERE entitlement_id = OLD.id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_survey_invitation_attendee() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invalidate_survey_attendee_booking ON public.booking;
CREATE TRIGGER invalidate_survey_attendee_booking AFTER UPDATE OR DELETE ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.invalidate_survey_invitation_attendee();
DROP TRIGGER IF EXISTS invalidate_survey_attendee_complex_booking ON public.complex_event_booking;
CREATE TRIGGER invalidate_survey_attendee_complex_booking AFTER UPDATE OR DELETE ON public.complex_event_booking
FOR EACH ROW EXECUTE FUNCTION public.invalidate_survey_invitation_attendee();
DROP TRIGGER IF EXISTS invalidate_survey_attendee_member ON public.member;
CREATE TRIGGER invalidate_survey_attendee_member AFTER UPDATE OR DELETE ON public.member
FOR EACH ROW EXECUTE FUNCTION public.invalidate_survey_invitation_attendee();
DROP TRIGGER IF EXISTS invalidate_survey_attendee_entitlement ON public.certificate_survey_entitlement;
CREATE TRIGGER invalidate_survey_attendee_entitlement AFTER UPDATE OR DELETE ON public.certificate_survey_entitlement
FOR EACH ROW EXECUTE FUNCTION public.invalidate_survey_invitation_attendee();

CREATE OR REPLACE FUNCTION public.confirm_survey_invitation_attendee(
  p_tenant_id uuid, p_entitlement_id uuid, p_credential_id uuid, p_member_id uuid,
  p_booking_revision bigint, p_entitlement_revision bigint, p_member_revision bigint,
  p_booking_fingerprint text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g public.certificate_survey_entitlement%ROWTYPE;
  c public.certificate_survey_credential%ROWTYPE;
  m public.member%ROWTYPE;
  a public.event_survey_assignment%ROWTYPE;
  f public.form%ROWTYPE;
  b jsonb;
  delivery_ok boolean;
BEGIN
  SELECT * INTO g FROM public.certificate_survey_entitlement WHERE id=p_entitlement_id FOR UPDATE;
  SELECT * INTO c FROM public.certificate_survey_credential WHERE id=p_credential_id FOR SHARE;
  SELECT * INTO m FROM public.member WHERE id=p_member_id FOR SHARE;
  IF g.booking_source='standard' THEN
    SELECT to_jsonb(t) INTO b FROM public.booking t WHERE id=g.booking_id FOR SHARE;
  ELSIF g.booking_source='complex' THEN
    SELECT to_jsonb(t) INTO b FROM public.complex_event_booking t WHERE id=g.booking_id FOR SHARE;
  END IF;
  SELECT * INTO a FROM public.event_survey_assignment WHERE id=g.assignment_id FOR SHARE;
  SELECT * INTO f FROM public.form WHERE id=a.form_id FOR SHARE;
  IF c.campaign_delivery_id IS NOT NULL THEN
    SELECT status='accepted' INTO delivery_ok FROM public.campaign_survey_delivery
      WHERE id=c.campaign_delivery_id AND tenant_id=p_tenant_id
        AND booking_source=g.booking_source AND booking_id=g.booking_id FOR SHARE;
  ELSE
    SELECT status='accepted' INTO delivery_ok FROM public.attendee_cpd_certificate_delivery
      WHERE id=c.delivery_id AND tenant_id=p_tenant_id
        AND booking_source=g.booking_source AND booking_id=g.booking_id FOR SHARE;
  END IF;
  IF g.id IS NULL OR c.id IS NULL OR m.id IS NULL OR b IS NULL OR a.id IS NULL OR f.id IS NULL
    OR g.tenant_id IS DISTINCT FROM p_tenant_id OR m.tenant_id IS DISTINCT FROM p_tenant_id
    OR (b->>'tenant_id')::uuid IS DISTINCT FROM p_tenant_id OR a.tenant_id IS DISTINCT FROM p_tenant_id
    OR f.tenant_id IS DISTINCT FROM p_tenant_id
    OR g.survey_invitation_revision IS DISTINCT FROM p_entitlement_revision
    OR m.survey_invitation_revision IS DISTINCT FROM p_member_revision
    OR (b->>'survey_invitation_revision')::bigint IS DISTINCT FROM p_booking_revision
    OR c.entitlement_id IS DISTINCT FROM g.id OR c.revoked_at IS NOT NULL OR c.expires_at <= clock_timestamp()
    OR g.revoked_at IS NOT NULL OR g.completed_at IS NOT NULL OR g.expires_at <= clock_timestamp()
    OR delivery_ok IS DISTINCT FROM true
    OR m.login_enabled IS FALSE OR m.membership_paused IS TRUE
    OR lower(trim(m.email)) IS DISTINCT FROM g.recipient_email
    OR lower(trim(b->>'attendee_email')) IS DISTINCT FROM g.recipient_email
    OR b->>'status' IS DISTINCT FROM 'confirmed'
    OR a.event_type IS DISTINCT FROM (CASE WHEN g.booking_source='standard' THEN 'event' ELSE 'complex_event' END)
    OR (b->>'event_id')::uuid IS DISTINCT FROM (CASE WHEN g.booking_source='standard' THEN a.event_id ELSE a.complex_event_id END)
    OR a.status IS DISTINCT FROM 'active' OR a.opens_at > clock_timestamp() OR a.closes_at < clock_timestamp()
    OR f.is_active IS DISTINCT FROM true OR f.form_type IS DISTINCT FROM 'survey'
    OR f.survey_settings->>'status' IS DISTINCT FROM 'published'
    OR f.deactivate_at <= clock_timestamp()
  THEN RAISE EXCEPTION 'Invitation confirmation authority changed' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.survey_invitation_attendee
    (entitlement_id,tenant_id,member_id,recipient_email,booking_fingerprint)
    VALUES(g.id,p_tenant_id,m.id,g.recipient_email,p_booking_fingerprint)
    ON CONFLICT (entitlement_id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,
      member_id=EXCLUDED.member_id,recipient_email=EXCLUDED.recipient_email,
      booking_fingerprint=EXCLUDED.booking_fingerprint,confirmed_at=now();
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_survey_invitation_attendee(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_survey_invitation_attendee(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text) TO service_role;