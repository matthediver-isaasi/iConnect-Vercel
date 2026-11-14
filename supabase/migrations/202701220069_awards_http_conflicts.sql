BEGIN;
-- 40001 means a genuinely retryable serialization failure to PostgREST.
-- Optimistic version conflicts are permanent for that request: return PT409.
-- Restrict this conversion to the exact new awards command surface.
DO $$
DECLARE command_name text; definition text; function_oid oid; matches integer;
BEGIN
  FOREACH command_name IN ARRAY ARRAY[
    'assessment_adopt_snapshot','assessment_advance_round','assessment_appointment_availability',
    'assessment_assignment_command','assessment_configure_round','assessment_confirm_allocation',
    'assessment_declare_conflict','assessment_decline_assignment','assessment_moderate',
    'assessment_panel_conflict_command','assessment_panel_policy','assessment_panel_review_conflict',
    'assessment_record_revision','assessment_record_shortlist','assessment_reopen','assessment_respond_member',
    'assessment_revise_criteria','assessment_rotate_invitation','assessment_round_transition','assessment_save_template',
    'awards_applicant_access_control','awards_application_decide','awards_configure','awards_configure_automatic_messages',
    'awards_configure_message','awards_delivery_control','awards_duplicate','awards_event_command',
    'awards_prepare_amendment','awards_programme_command','awards_publish_outcome','awards_publish_shortlist',
    'awards_queue_invitation','awards_record_amendment','awards_record_outcome','awards_reopen_review',
    'awards_require_active_review','awards_revoke_certificate_links','awards_save_certificate_template'
  ] LOOP
    SELECT count(*),min(p.oid) INTO matches,function_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=command_name;
    IF matches<>1 THEN RAISE EXCEPTION 'Unexpected awards command overload: %',command_name; END IF;
    definition:=pg_get_functiondef(function_oid);
    IF position('''40001''' IN definition)=0 THEN RAISE EXCEPTION 'Expected conflict contract missing: %',command_name; END IF;
    EXECUTE replace(definition,'''40001''','''PT409''');
  END LOOP;
END $$;
COMMIT;
