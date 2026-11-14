BEGIN;
ALTER TABLE public.form_submission ADD COLUMN awards_binding_id uuid REFERENCES public.awards_form_binding(id) ON DELETE RESTRICT;
ALTER TABLE public.form_submission ADD COLUMN awards_applicant_member_id uuid REFERENCES public.member(id) ON DELETE RESTRICT;
CREATE TABLE public.awards_intake_capture (
  submission_id uuid PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  member_id uuid REFERENCES public.member(id) ON DELETE RESTRICT,
  form_snapshot jsonb NOT NULL,
  answer_snapshot jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,award_id,binding_id) REFERENCES public.awards_form_binding(tenant_id,award_id,id)
);
ALTER TABLE public.awards_intake_capture ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.awards_intake_capture FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.awards_intake_capture TO service_role;
CREATE FUNCTION public.awards_capture_submission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE binding public.awards_form_binding; award public.awards_competition; form_record jsonb; survey_record jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.awards_binding_id IS DISTINCT FROM NEW.awards_binding_id
      OR OLD.awards_applicant_member_id IS DISTINCT FROM NEW.awards_applicant_member_id THEN RAISE EXCEPTION 'Award context cannot be reassigned'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.awards_binding_id IS NULL THEN RETURN NEW; END IF;
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO binding FROM public.awards_form_binding WHERE id=NEW.awards_binding_id;
  IF NOT FOUND OR binding.tenant_id IS DISTINCT FROM NEW.tenant_id OR binding.form_id IS DISTINCT FROM NEW.form_id OR NOT binding.active THEN
    RAISE EXCEPTION 'Award application context unavailable' USING ERRCODE='23514'; END IF;
  SELECT * INTO award FROM public.awards_competition WHERE tenant_id=binding.tenant_id AND id=binding.award_id FOR UPDATE;
  IF NOT FOUND OR award.state<>'open' OR award.opens_at IS NULL OR award.closes_at IS NULL
    OR clock_timestamp()<award.opens_at OR clock_timestamp()>=award.closes_at THEN
    RAISE EXCEPTION 'Award applications are closed' USING ERRCODE='23514'; END IF;
  SELECT jsonb_build_object('id',f.id,'name',f.name,'fields',f.fields,'pages',f.pages,'layout_type',f.layout_type,
    'visibility_rules',coalesce(to_jsonb(f)->'visibility_rules','[]'),'form_type',to_jsonb(f)->'form_type')
    INTO form_record FROM public.form f WHERE f.id=NEW.form_id AND f.tenant_id=NEW.tenant_id AND f.is_active FOR SHARE;
  IF form_record IS NULL THEN RAISE EXCEPTION 'Application form unavailable'; END IF;
  IF to_jsonb(NEW)->>'survey_version_id' IS NOT NULL THEN
    SELECT to_jsonb(v) INTO survey_record FROM public.survey_version v
      WHERE v.id=(to_jsonb(NEW)->>'survey_version_id')::uuid AND v.tenant_id=NEW.tenant_id AND v.form_id=NEW.form_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Submitted survey version unavailable'; END IF;
    form_record:=form_record||jsonb_build_object('survey_version_id',survey_record->'id',
      'fields',survey_record->'fields','pages',survey_record->'pages',
      'visibility_rules',survey_record->'visibility_rules','survey_settings',survey_record->'survey_settings');
  END IF;
  INSERT INTO public.awards_intake_capture(submission_id,tenant_id,award_id,binding_id,member_id,form_snapshot,answer_snapshot)
    VALUES(NEW.id,NEW.tenant_id,award.id,binding.id,NEW.awards_applicant_member_id,
      form_record||jsonb_build_object('review_field_ids',binding.review_field_ids),coalesce(NEW.submission_data,'{}'::jsonb));
  RETURN NEW;
END $$;
CREATE TRIGGER awards_capture_submission AFTER INSERT OR UPDATE OF awards_binding_id,awards_applicant_member_id ON public.form_submission
FOR EACH ROW EXECUTE FUNCTION public.awards_capture_submission();
REVOKE ALL ON FUNCTION public.awards_capture_submission() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.awards_finalise_intake(p_tenant uuid,p_submission uuid,p_binding uuid,p_display jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE captured public.awards_intake_capture; application public.awards_application;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT * INTO captured FROM public.awards_intake_capture WHERE tenant_id=p_tenant AND submission_id=p_submission;
  -- Serialize admission finalisation before inserting child rows. This also
  -- makes same-award duplicate flagging safe across concurrent submissions.
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=captured.award_id FOR UPDATE;
  IF NOT FOUND OR captured.binding_id IS DISTINCT FROM p_binding THEN
    RAISE EXCEPTION 'Saved submission belongs to a different award context' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=captured.award_id FOR UPDATE;
  PERFORM 1 FROM public.awards_intake_capture WHERE tenant_id=p_tenant AND submission_id=p_submission FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.form_submission s WHERE s.id=p_submission
    AND to_jsonb(s)->>'awards_amendment_application_id' IS NOT NULL) THEN
    RAISE EXCEPTION 'Use amendment finalisation for revised evidence'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(captured.form_snapshot->'fields') field
    WHERE field->>'type'='file' AND captured.form_snapshot->'review_field_ids' ? (field->>'id')
      AND captured.answer_snapshot->(field->>'id') IS NOT NULL
      AND captured.answer_snapshot->(field->>'id') NOT IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb)
      AND (SELECT count(*) FROM public.awards_review_attachment f WHERE f.tenant_id=p_tenant AND f.submission_id=p_submission
        AND f.field_id=field->>'id') <
        CASE WHEN jsonb_typeof(captured.answer_snapshot->(field->>'id'))='array'
          THEN jsonb_array_length(captured.answer_snapshot->(field->>'id')) ELSE 1 END
  ) THEN RAISE EXCEPTION 'Review attachments have not been retained'; END IF;
  PERFORM public.awards_assert_repeatable_files_retained(p_tenant,p_submission);
  -- Finalisation uses admission time, not the clock after pipeline completion.
  -- A lost response after the deadline must recover the same application.
  SELECT * INTO application FROM public.awards_application
    WHERE tenant_id=p_tenant AND award_id=captured.award_id AND submission_id=p_submission;
  IF FOUND THEN RETURN jsonb_build_object('id',application.id,'reference',application.reference,'status','received'); END IF;
  INSERT INTO public.awards_application(tenant_id,award_id,binding_id,submission_id,reference,member_id)
    VALUES(p_tenant,captured.award_id,captured.binding_id,p_submission,
      'AW-'||upper(replace(p_submission::text,'-','')),captured.member_id) RETURNING * INTO application;
  PERFORM public.awards_flag_potential_duplicates(p_tenant,application.id);
  PERFORM public.awards_validate_display_snapshot(captured.form_snapshot,p_display);
  INSERT INTO public.awards_application_version(tenant_id,application_id,revision,form_snapshot,answer_snapshot,display_snapshot,attachment_manifest)
    VALUES(p_tenant,application.id,1,captured.form_snapshot,captured.answer_snapshot,p_display,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'field_id',f.field_id,'cell_id',f.cell_id,'name',f.name,'sha256',f.digest) ORDER BY f.id),'[]')
        FROM public.awards_review_attachment f WHERE f.tenant_id=p_tenant AND f.submission_id=p_submission));
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,action,subject_id,changes)
    VALUES(p_tenant,captured.award_id,'system','application.received',application.id,jsonb_build_object('submission_id',p_submission));
  RETURN jsonb_build_object('id',application.id,'reference',application.reference,'status','received');
END $$;
REVOKE ALL ON FUNCTION public.awards_finalise_intake(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_finalise_intake(uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
