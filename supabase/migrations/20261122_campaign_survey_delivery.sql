-- Generalize survey entitlement provenance without impersonating certificate
-- delivery. Apply AFTER 20261121_certificate_survey_grants.sql, on DEST only.
BEGIN;
CREATE TABLE IF NOT EXISTS public.campaign_survey_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  campaign_id uuid NOT NULL REFERENCES public.email_campaign(id),
  campaign_recipient_id uuid REFERENCES public.email_campaign_recipient(id),
  purpose text NOT NULL CHECK (purpose IN ('live', 'test')),
  booking_source text NOT NULL CHECK (booking_source IN ('standard', 'complex')),
  booking_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('event', 'complex_event')),
  event_id uuid NOT NULL,
  source_email text NOT NULL,
  destination_email text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((purpose = 'live' AND campaign_recipient_id IS NOT NULL AND source_email = lower(trim(destination_email)))
    OR (purpose = 'test' AND campaign_recipient_id IS NULL))
);
-- A pending/unknown live attempt cannot be resent automatically. A failed
-- attempt may be retried; an accepted one only reconciles recipient state.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_survey_delivery_live_claim
  ON public.campaign_survey_delivery(campaign_id, campaign_recipient_id)
  WHERE purpose = 'live' AND status IN ('pending', 'accepted');
ALTER TABLE public.campaign_survey_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_survey_delivery FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.campaign_survey_delivery TO service_role;
GRANT UPDATE(status, resolved_at) ON public.campaign_survey_delivery TO service_role;

CREATE OR REPLACE FUNCTION public.guard_campaign_survey_delivery() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'pending' OR NEW.status NOT IN ('accepted', 'failed')
      OR (to_jsonb(NEW) - 'status' - 'resolved_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'resolved_at')
      OR NEW.resolved_at IS NULL
    THEN RAISE EXCEPTION 'Campaign survey delivery is immutable once resolved'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'pending' OR NEW.resolved_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM public.email_campaign c WHERE c.id = NEW.campaign_id AND c.tenant_id = NEW.tenant_id)
    OR (NEW.purpose = 'live' AND NOT EXISTS (
      SELECT 1 FROM public.email_campaign_recipient r WHERE r.id = NEW.campaign_recipient_id
        AND r.campaign_id = NEW.campaign_id AND lower(trim(r.email)) = NEW.source_email
        AND r.status = 'processing'))
  THEN RAISE EXCEPTION 'Invalid campaign survey delivery provenance'; END IF;
  IF NEW.booking_source = 'standard' THEN
    IF NEW.event_type <> 'event' OR NOT EXISTS (
      SELECT 1 FROM public.booking b WHERE b.id = NEW.booking_id AND b.tenant_id = NEW.tenant_id
        AND b.event_id = NEW.event_id AND b.status = 'confirmed' AND lower(trim(b.attendee_email)) = NEW.source_email
    ) THEN RAISE EXCEPTION 'Invalid confirmed campaign attendee'; END IF;
  ELSE
    IF NEW.event_type <> 'complex_event' OR NOT EXISTS (
      SELECT 1 FROM public.complex_event_booking b WHERE b.id = NEW.booking_id AND b.tenant_id = NEW.tenant_id
        AND b.event_id = NEW.event_id AND b.status = 'confirmed' AND lower(trim(b.attendee_email)) = NEW.source_email
    ) THEN RAISE EXCEPTION 'Invalid confirmed campaign attendee'; END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.guard_campaign_survey_delivery() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_campaign_survey_delivery ON public.campaign_survey_delivery;
CREATE TRIGGER guard_campaign_survey_delivery BEFORE INSERT OR UPDATE ON public.campaign_survey_delivery
  FOR EACH ROW EXECUTE FUNCTION public.guard_campaign_survey_delivery();

ALTER TABLE public.certificate_survey_credential ALTER COLUMN delivery_id DROP NOT NULL;
ALTER TABLE public.certificate_survey_credential ADD COLUMN IF NOT EXISTS campaign_delivery_id uuid
  REFERENCES public.campaign_survey_delivery(id);
DO $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'survey_credential_one_delivery'
    AND conrelid = 'public.certificate_survey_credential'::regclass) THEN
    ALTER TABLE public.certificate_survey_credential ADD CONSTRAINT survey_credential_one_delivery
      CHECK (num_nonnulls(delivery_id, campaign_delivery_id) = 1);
  END IF;
END;
$fn$;
CREATE INDEX IF NOT EXISTS certificate_survey_credential_campaign_delivery_idx
  ON public.certificate_survey_credential(campaign_delivery_id);

-- Service-only common read model. The discriminator prevents even an equal UUID
-- in the two ledgers from substituting one kind of delivery for the other.
CREATE OR REPLACE VIEW public.survey_invitation_delivery AS
  SELECT id, tenant_id, booking_source, booking_id, status, 'certificate'::text AS kind
    FROM public.attendee_cpd_certificate_delivery
  UNION ALL
  SELECT id, tenant_id, booking_source, booking_id, status, 'campaign'::text AS kind
    FROM public.campaign_survey_delivery;
REVOKE ALL ON public.survey_invitation_delivery FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.survey_invitation_delivery TO service_role;

CREATE OR REPLACE FUNCTION public.guard_certificate_survey_credential() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM public.certificate_survey_entitlement e
    JOIN public.survey_invitation_delivery d ON
      ((d.kind = 'certificate' AND d.id = NEW.delivery_id)
        OR (d.kind = 'campaign' AND d.id = NEW.campaign_delivery_id))
    WHERE e.id = NEW.entitlement_id AND d.tenant_id = e.tenant_id
      AND d.booking_source = e.booking_source AND d.booking_id = e.booking_id AND d.status = 'pending'
      AND (d.kind = 'certificate' OR EXISTS (
        SELECT 1 FROM public.campaign_survey_delivery cd
        JOIN public.event_survey_assignment a ON a.id = e.assignment_id AND a.tenant_id = e.tenant_id
        WHERE cd.id = NEW.campaign_delivery_id AND cd.source_email = e.recipient_email
          AND cd.event_type = a.event_type
          AND cd.event_id = CASE WHEN a.event_type = 'event' THEN a.event_id ELSE a.complex_event_id END
      ))
  ) THEN RAISE EXCEPTION 'Survey credential must belong to its pending delivery'; END IF;
  IF TG_OP = 'UPDATE' AND (
    (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id
    OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
    OR NEW.campaign_delivery_id IS DISTINCT FROM OLD.campaign_delivery_id
    OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
  ) THEN RAISE EXCEPTION 'Survey credential scope and delivery state are immutable'; END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.guard_certificate_survey_credential() FROM PUBLIC, anon, authenticated;

-- Preserve the entire existing atomic booking/publication/completion contract.
-- Fail closed if that function no longer has the expected delivery checks.
-- This also keeps subsequent application of this migration idempotent.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.create_certificate_survey_submission(jsonb,jsonb,text)'::regprocedure);
BEGIN
  IF position('public.survey_invitation_delivery' in definition) = 0 THEN
    IF position('d.id = c.delivery_id' in definition) = 0
      OR position('d.id = v_credential.delivery_id' in definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected survey submission function; review migration before applying';
    END IF;
    definition := replace(definition, 'public.attendee_cpd_certificate_delivery', 'public.survey_invitation_delivery');
    definition := replace(definition, 'd.id = c.delivery_id',
      '((d.kind = ''certificate'' AND d.id = c.delivery_id) OR (d.kind = ''campaign'' AND d.id = c.campaign_delivery_id))');
    definition := replace(definition, 'd.id = v_credential.delivery_id',
      '((d.kind = ''certificate'' AND d.id = v_credential.delivery_id) OR (d.kind = ''campaign'' AND d.id = v_credential.campaign_delivery_id))');
    -- UNION views cannot be row-locked; credential and entitlement remain locked.
    -- Delivery transitions are immutable after acceptance.
    definition := replace(definition, 'c.expires_at > now() FOR SHARE;', 'c.expires_at > now() FOR SHARE OF c;');
    EXECUTE definition;
  END IF;
END;
$migration$;
REVOKE ALL ON FUNCTION public.create_certificate_survey_submission(jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_certificate_survey_submission(jsonb,jsonb,text) TO service_role;
COMMIT;