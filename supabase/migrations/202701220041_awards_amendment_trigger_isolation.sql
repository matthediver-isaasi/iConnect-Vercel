BEGIN;
-- Preserve each installed trigger's original event, timing, arguments,
-- predicate and enablement. Only server-owned amendment rows are excluded.
-- Do not replace provider/business function bodies or change ordinary intake.
DO $$
DECLARE item record; definition text; predicate text[]; rewritten text;
BEGIN
  FOR item IN
    SELECT t.tgname,t.tgtype,t.tgenabled,p.proname,pg_get_triggerdef(t.oid,true) definition
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='public.form_submission'::regclass AND NOT t.tgisinternal
        AND t.tgname IN (
          'allocate_submission_bundle','allocate_submission_cart','capture_form_submission_alerts',
          'check_failed_form_cart','form_bundle_submission_immutable','form_cart_submission_immutable',
          'form_date_membership_completion','form_invoice_order_guard','guard_survey_acceptance_response_policy',
          'guard_survey_lifecycle_submission','settle_submission_bundle','settle_submission_cart',
          'trg_bump_event_survey_assignment_responses','trigger_mark_paid_form_due_diligence_eligible',
          'zz_enqueue_form_invoice_order'
        )
  LOOP
    IF (item.tgtype::integer & 1)=0 OR (item.tgtype::integer & 8)<>0 THEN
      RAISE EXCEPTION 'Unsupported submission action trigger shape: %',item.tgname;
    END IF;
    definition:=item.definition;
    IF strpos(definition,' EXECUTE FUNCTION ')=0 THEN RAISE EXCEPTION 'Unsupported trigger definition: %',item.tgname; END IF;
    predicate:=regexp_match(definition,' WHEN \((.*)\) EXECUTE FUNCTION ');
    IF predicate IS NOT NULL THEN
      rewritten:=replace(definition,' WHEN ('||predicate[1]||') EXECUTE FUNCTION ',
        ' WHEN (('||predicate[1]||') AND NEW.awards_amendment_application_id IS NULL) EXECUTE FUNCTION ');
    ELSE
      rewritten:=replace(definition,' EXECUTE FUNCTION ',' WHEN (NEW.awards_amendment_application_id IS NULL) EXECUTE FUNCTION ');
    END IF;
    IF rewritten=definition THEN RAISE EXCEPTION 'Could not isolate submission action trigger: %',item.tgname; END IF;
    EXECUTE format('DROP TRIGGER %I ON public.form_submission',item.tgname);
    EXECUTE rewritten;
    IF item.tgenabled='D' THEN EXECUTE format('ALTER TABLE public.form_submission DISABLE TRIGGER %I',item.tgname);
    ELSIF item.tgenabled='R' THEN EXECUTE format('ALTER TABLE public.form_submission ENABLE REPLICA TRIGGER %I',item.tgname);
    ELSIF item.tgenabled='A' THEN EXECUTE format('ALTER TABLE public.form_submission ENABLE ALWAYS TRIGGER %I',item.tgname);
    END IF;
  END LOOP;
END $$;
COMMIT;
