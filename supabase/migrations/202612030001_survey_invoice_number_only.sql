-- Invoice display labels are not attendee authority. Preserve confirmations
-- only when a booking's invoice-number mirror actually changes and EVERY other
-- column (including survey revision, provider IDs and purchaser data) is equal.
-- No-op updates and all other changes retain the existing invalidation policy.
CREATE OR REPLACE FUNCTION public.bump_survey_invitation_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('booking', 'complex_event_booking')
    AND (to_jsonb(NEW) - ARRAY['xero_invoice_number','accounting_invoice_number'])
      = (to_jsonb(OLD) - ARRAY['xero_invoice_number','accounting_invoice_number'])
    AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
  THEN
    RETURN NEW;
  END IF;
  NEW.survey_invitation_revision := OLD.survey_invitation_revision + 1;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.bump_survey_invitation_revision() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.invalidate_survey_invitation_attendee()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME IN ('booking', 'complex_event_booking') THEN
    IF TG_OP = 'UPDATE'
      AND (to_jsonb(NEW) - ARRAY['xero_invoice_number','accounting_invoice_number'])
        = (to_jsonb(OLD) - ARRAY['xero_invoice_number','accounting_invoice_number'])
      AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
    THEN
      RETURN NULL;
    END IF;
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