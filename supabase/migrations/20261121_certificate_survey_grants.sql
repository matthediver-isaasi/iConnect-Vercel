-- Certificate survey invitation capabilities. Only the service role may read
-- these rows; the public assignment token is NOT a recipient capability.
CREATE TABLE public.certificate_survey_entitlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  booking_source text NOT NULL CHECK (booking_source IN ('standard', 'complex')),
  booking_id uuid NOT NULL,
  assignment_id uuid NOT NULL REFERENCES public.event_survey_assignment(id),
  recipient_email text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  completed_at timestamptz,
  -- Private service-only evidence; never joined into anonymous reporting.
  response_id uuid UNIQUE REFERENCES public.form_submission(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, booking_source, booking_id, assignment_id)
);
CREATE TABLE public.certificate_survey_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id uuid NOT NULL REFERENCES public.certificate_survey_entitlement(id),
  -- Delivery ledger is the sole acceptance authority. No second activation
  -- write can be lost after a successful provider acceptance/audit update.
  delivery_id uuid NOT NULL REFERENCES public.attendee_cpd_certificate_delivery(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX certificate_survey_credential_entitlement_idx
  ON public.certificate_survey_credential(entitlement_id);
CREATE INDEX certificate_survey_credential_delivery_idx
  ON public.certificate_survey_credential(delivery_id);
ALTER TABLE public.certificate_survey_entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certificate_survey_credential ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.certificate_survey_entitlement, public.certificate_survey_credential FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.certificate_survey_entitlement, public.certificate_survey_credential TO service_role;
GRANT UPDATE (expires_at, revoked_at) ON public.certificate_survey_entitlement TO service_role;
GRANT UPDATE (revoked_at) ON public.certificate_survey_credential TO service_role;

CREATE FUNCTION public.guard_certificate_survey_entitlement() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.completed_at IS NOT NULL OR NEW.response_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Survey entitlement cannot start completed';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR (OLD.response_id IS NOT NULL AND NEW.response_id IS DISTINCT FROM OLD.response_id)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.booking_source IS DISTINCT FROM OLD.booking_source
    OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
    OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
    OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
  ) THEN RAISE EXCEPTION 'Survey entitlement scope, completion and revocation are immutable'; END IF;
  IF (NEW.response_id IS NULL) IS DISTINCT FROM (NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'Survey completion and response evidence must change together';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER guard_certificate_survey_entitlement BEFORE INSERT OR UPDATE
ON public.certificate_survey_entitlement FOR EACH ROW
EXECUTE FUNCTION public.guard_certificate_survey_entitlement();

CREATE FUNCTION public.guard_certificate_survey_credential() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM public.certificate_survey_entitlement e
    JOIN public.attendee_cpd_certificate_delivery d ON d.id = NEW.delivery_id
    WHERE e.id = NEW.entitlement_id AND d.tenant_id = e.tenant_id
      AND d.booking_source = e.booking_source AND d.booking_id = e.booking_id
      AND d.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Survey credential must belong to its pending delivery';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id
    OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
    OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
  ) THEN RAISE EXCEPTION 'Survey credential scope and delivery state are immutable'; END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER guard_certificate_survey_credential BEFORE INSERT OR UPDATE
ON public.certificate_survey_credential FOR EACH ROW
EXECUTE FUNCTION public.guard_certificate_survey_credential();

-- Atomic claim and insertion. The entitlement lock serializes concurrent tabs;
-- completion has no submission FK (anonymous results remain unlinked).
CREATE FUNCTION public.create_certificate_survey_submission(
  p_submission jsonb, p_answers jsonb, p_token_hash text
) RETURNS SETOF public.form_submission
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_grant public.certificate_survey_entitlement;
  v_credential public.certificate_survey_credential;
  v_assignment public.event_survey_assignment;
  v_form public.form;
  v_booking_status text;
  v_booking_email text;
  v_booking_event uuid;
  v_row public.form_submission;
BEGIN
  SELECT c.* INTO v_credential FROM public.certificate_survey_credential c
    JOIN public.attendee_cpd_certificate_delivery d ON d.id = c.delivery_id
    WHERE c.token_hash = p_token_hash AND d.status = 'accepted'
      AND c.revoked_at IS NULL AND c.expires_at > now() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Certificate survey invitation unavailable' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_grant FROM public.certificate_survey_entitlement
    WHERE id = v_credential.entitlement_id FOR UPDATE;
  IF v_grant.id IS NULL OR v_grant.completed_at IS NOT NULL OR v_grant.revoked_at IS NOT NULL
     OR v_grant.expires_at <= now() THEN
    RAISE EXCEPTION 'Certificate survey invitation unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.attendee_cpd_certificate_delivery d
    WHERE d.id = v_credential.delivery_id AND d.status = 'accepted'
      AND d.tenant_id = v_grant.tenant_id
      AND d.booking_source = v_grant.booking_source AND d.booking_id = v_grant.booking_id
  ) THEN
    RAISE EXCEPTION 'Certificate survey invitation unavailable' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_assignment FROM public.event_survey_assignment
    WHERE id = v_grant.assignment_id AND tenant_id = v_grant.tenant_id FOR SHARE;
  SELECT * INTO v_form FROM public.form
    WHERE id = v_assignment.form_id AND tenant_id = v_grant.tenant_id FOR SHARE;
  IF v_assignment.id IS NULL
     OR (v_grant.booking_source = 'standard' AND v_assignment.event_type <> 'event')
     OR (v_grant.booking_source = 'complex' AND v_assignment.event_type <> 'complex_event')
     OR v_assignment.status <> 'active'
     OR (v_assignment.opens_at IS NOT NULL AND v_assignment.opens_at > now())
     OR (v_assignment.closes_at IS NOT NULL AND v_assignment.closes_at < now())
     OR v_form.id IS NULL OR v_form.form_type <> 'survey' OR NOT v_form.is_active
     OR (v_form.deactivate_at IS NOT NULL AND v_form.deactivate_at <= now())
     OR v_form.survey_settings->>'status' <> 'published'
     OR (p_submission->>'tenant_id')::uuid IS DISTINCT FROM v_grant.tenant_id
     OR (p_submission->>'form_id')::uuid IS DISTINCT FROM v_assignment.form_id
     OR (p_submission->>'survey_assignment_id')::uuid IS DISTINCT FROM v_assignment.id
     OR (p_submission->>'survey_version_id')::uuid IS DISTINCT FROM
       (SELECT sv.id FROM public.survey_version sv WHERE sv.form_id = v_form.id AND sv.tenant_id = v_grant.tenant_id
        AND sv.version_number = (v_form.survey_settings->>'current_version')::int LIMIT 1)
     OR (p_submission->>'event_id')::uuid IS DISTINCT FROM v_assignment.event_id
     OR (p_submission->>'complex_event_id')::uuid IS DISTINCT FROM v_assignment.complex_event_id
  THEN RAISE EXCEPTION 'Certificate survey invitation scope or publication changed' USING ERRCODE = 'P0001'; END IF;
  IF v_grant.booking_source = 'standard' THEN
    SELECT status, attendee_email, event_id INTO v_booking_status, v_booking_email, v_booking_event
      FROM public.booking WHERE id = v_grant.booking_id AND tenant_id = v_grant.tenant_id FOR SHARE;
    IF v_booking_event IS DISTINCT FROM v_assignment.event_id THEN
      RAISE EXCEPTION 'Certificate survey booking event changed' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT status, attendee_email, event_id INTO v_booking_status, v_booking_email, v_booking_event
      FROM public.complex_event_booking WHERE id = v_grant.booking_id AND tenant_id = v_grant.tenant_id FOR SHARE;
    IF v_booking_event IS DISTINCT FROM v_assignment.complex_event_id THEN
      RAISE EXCEPTION 'Certificate survey booking event changed' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF v_booking_status IS DISTINCT FROM 'confirmed' OR lower(trim(v_booking_email)) IS DISTINCT FROM v_grant.recipient_email THEN
    RAISE EXCEPTION 'Certificate survey booking is no longer confirmed for this recipient' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_row FROM public.create_survey_submission(p_submission, p_answers);
  UPDATE public.certificate_survey_entitlement SET completed_at = now(), response_id = v_row.id
  WHERE id = v_grant.id;
  RETURN NEXT v_row;
END;
$fn$;
REVOKE ALL ON FUNCTION public.create_certificate_survey_submission(jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_certificate_survey_submission(jsonb,jsonb,text) TO service_role;