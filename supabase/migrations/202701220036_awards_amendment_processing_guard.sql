BEGIN;
-- Evidence-only amendment rows must never start a new due-diligence workflow,
-- including through recovery workers or direct service-side initialization.
CREATE FUNCTION public.awards_block_amendment_due_diligence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE submission uuid;
BEGIN
  submission:=(to_jsonb(NEW)->>'form_submission_id')::uuid;
  IF EXISTS(SELECT 1 FROM public.form_submission s WHERE s.id=submission
    AND s.awards_amendment_application_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Award amendments update review evidence only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.awards_block_amendment_due_diligence() FROM PUBLIC,anon,authenticated,service_role;
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['form_due_diligence_initialization','form_submission_due_diligence'] LOOP
    IF to_regclass('public.'||target) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.'||target)
      AND attname='form_submission_id' AND NOT attisdropped) THEN
      RAISE EXCEPTION 'Unsupported due-diligence submission relationship: %',target;
    END IF;
    EXECUTE format('CREATE TRIGGER awards_evidence_only BEFORE INSERT OR UPDATE OF form_submission_id ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awards_block_amendment_due_diligence()',target);
  END LOOP;
END $$;
COMMIT;
