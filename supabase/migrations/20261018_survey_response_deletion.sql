-- Response deletion must remove normalized answers and update event counts in
-- the same transaction. Historical invitation completion remains immutable.
BEGIN;

-- Retain the historical response UUID as completion evidence, even when an
-- administrator deletes the response. Do not clear completed_at or re-enable
-- the invitation. This column is private/service-only, not a reporting source.
ALTER TABLE public.certificate_survey_entitlement
  DROP CONSTRAINT IF EXISTS certificate_survey_entitlement_response_id_fkey;
COMMENT ON COLUMN public.certificate_survey_entitlement.response_id IS
  'Historical accepted response UUID; may refer to an administrator-deleted response. Completion remains immutable.';

CREATE OR REPLACE FUNCTION public.cleanup_deleted_survey_response()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  DELETE FROM public.survey_answer
  WHERE submission_id = OLD.id AND tenant_id = OLD.tenant_id;

  IF OLD.survey_assignment_id IS NOT NULL THEN
    -- Serialize with insert-time counter updates. Keep the delta atomic even
    -- when another response is inserted/deleted concurrently.
    PERFORM 1 FROM public.event_survey_assignment
    WHERE id = OLD.survey_assignment_id AND tenant_id = OLD.tenant_id
    FOR UPDATE;
    UPDATE public.event_survey_assignment
    SET response_count = GREATEST(0, response_count - 1),
        first_response_at = (
          SELECT min(created_date) FROM public.form_submission
          WHERE survey_assignment_id = OLD.survey_assignment_id AND tenant_id = OLD.tenant_id
        ),
        last_response_at = (
          SELECT max(created_date) FROM public.form_submission
          WHERE survey_assignment_id = OLD.survey_assignment_id AND tenant_id = OLD.tenant_id
        ),
        updated_at = now()
    WHERE id = OLD.survey_assignment_id AND tenant_id = OLD.tenant_id;
  END IF;
  RETURN OLD;
END;
$fn$;
REVOKE ALL ON FUNCTION public.cleanup_deleted_survey_response() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS cleanup_deleted_survey_response ON public.form_submission;
CREATE TRIGGER cleanup_deleted_survey_response AFTER DELETE ON public.form_submission
FOR EACH ROW EXECUTE FUNCTION public.cleanup_deleted_survey_response();
COMMIT;
