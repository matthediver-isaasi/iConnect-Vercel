BEGIN;
ALTER TABLE public.form_submission ADD COLUMN awards_amendment_application_id uuid
  REFERENCES public.awards_application(id) ON DELETE RESTRICT;
CREATE FUNCTION public.awards_amendment_context_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.awards_amendment_application_id IS DISTINCT FROM NEW.awards_amendment_application_id THEN
    RAISE EXCEPTION 'Amendment context cannot be reassigned'; END IF;
  IF NEW.awards_amendment_application_id IS NOT NULL THEN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.awards_application a JOIN public.awards_competition w ON w.id=a.award_id
      WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.awards_amendment_application_id
        AND a.member_id IS NOT DISTINCT FROM NEW.awards_applicant_member_id AND a.binding_id=NEW.awards_binding_id
        AND a.eligibility NOT IN ('withdrawn','disqualified') AND w.amendments_enabled AND w.state='open'
        AND clock_timestamp()>=w.opens_at AND clock_timestamp()<w.closes_at) THEN
      RAISE EXCEPTION 'Amendment context unavailable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER awards_amendment_context_guard BEFORE INSERT OR UPDATE OF awards_amendment_application_id ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.awards_amendment_context_guard();
REVOKE ALL ON FUNCTION public.awards_amendment_context_guard() FROM PUBLIC,anon,authenticated,service_role;
-- Provenance for evidence-only canonical submissions, separate from their
-- original application's immutable submission_id.
CREATE TABLE public.awards_amendment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  application_id uuid NOT NULL,
  application_version_id uuid NOT NULL,
  submission_id uuid NOT NULL UNIQUE REFERENCES public.form_submission(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES public.member(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK(length(btrim(reason))>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,application_id,application_version_id)
    REFERENCES public.awards_application_version(tenant_id,application_id,id)
);
ALTER TABLE public.awards_amendment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.awards_amendment FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.awards_amendment TO service_role;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON public.awards_amendment
  FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence();
CREATE FUNCTION public.awards_record_amendment(p_tenant uuid,p_member uuid,p_application uuid,p_submission uuid,
  p_expected_version bigint,p_reason text,p_access_hash text DEFAULT NULL,p_display jsonb DEFAULT '{}',p_existing_choice_access boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.awards_application; w public.awards_competition; capture public.awards_intake_capture;
  existing public.awards_amendment; snapshot uuid; next_revision integer; access_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_member IS NULL THEN access_id:=public.awards_external_applicant(p_tenant,p_application,p_access_hash); END IF;
  IF (p_member IS NULL AND access_id IS NULL) OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Applicant and amendment reason required'; END IF;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application AND member_id IS NOT DISTINCT FROM p_member;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO w FROM public.awards_competition WHERE tenant_id=p_tenant AND id=a.award_id FOR UPDATE;
  SELECT * INTO a FROM public.awards_application WHERE tenant_id=p_tenant AND id=p_application AND member_id IS NOT DISTINCT FROM p_member FOR UPDATE;
  IF p_member IS NULL AND public.awards_external_applicant(p_tenant,p_application,p_access_hash) IS NULL THEN
    RAISE EXCEPTION 'Applicant access expired or revoked' USING ERRCODE='42501'; END IF;
  SELECT * INTO existing FROM public.awards_amendment WHERE submission_id=p_submission;
  IF FOUND THEN
    IF existing.tenant_id IS DISTINCT FROM p_tenant OR existing.application_id IS DISTINCT FROM a.id OR existing.member_id IS DISTINCT FROM p_member
      OR existing.reason IS DISTINCT FROM p_reason THEN RAISE EXCEPTION 'Amendment request already used' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('id',existing.id,'applicationVersionId',existing.application_version_id,'replayed',true);
  END IF;
  IF a.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Application changed' USING ERRCODE='40001'; END IF;
  IF NOT w.amendments_enabled OR w.state<>'open' OR w.opens_at IS NULL OR w.closes_at IS NULL
    OR clock_timestamp()<w.opens_at OR clock_timestamp()>=w.closes_at
    OR a.eligibility IN ('withdrawn','disqualified') THEN RAISE EXCEPTION 'Amendments are not available'; END IF;
  SELECT * INTO capture FROM public.awards_intake_capture WHERE tenant_id=p_tenant AND submission_id=p_submission FOR UPDATE;
  IF NOT FOUND OR capture.member_id IS DISTINCT FROM p_member OR capture.binding_id IS DISTINCT FROM a.binding_id
    OR capture.award_id IS DISTINCT FROM a.award_id OR EXISTS(SELECT 1 FROM public.awards_application WHERE submission_id=p_submission)
    OR NOT EXISTS(SELECT 1 FROM public.form_submission WHERE id=p_submission AND tenant_id=p_tenant AND awards_amendment_application_id=a.id) THEN
    RAISE EXCEPTION 'Amendment submission context unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(capture.form_snapshot->'fields') f
    WHERE f->>'type'='file' AND capture.form_snapshot->'review_field_ids' ? (f->>'id')
      AND capture.answer_snapshot->(f->>'id') IS NOT NULL
      AND capture.answer_snapshot->(f->>'id') NOT IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb)
      AND (SELECT count(*) FROM public.awards_review_attachment x WHERE x.tenant_id=p_tenant AND x.submission_id=p_submission AND x.field_id=f->>'id')
        < CASE WHEN jsonb_typeof(capture.answer_snapshot->(f->>'id'))='array'
          THEN jsonb_array_length(capture.answer_snapshot->(f->>'id')) ELSE 1 END) THEN
    RAISE EXCEPTION 'Review attachments have not been retained'; END IF;
  PERFORM public.awards_assert_repeatable_files_retained(p_tenant,p_submission);
  IF p_existing_choice_access IS DISTINCT FROM true AND public.awards_amendment_choice_changes(p_tenant,p_application,p_submission)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'Linked answers are read-only without existing form access' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(max(revision),0)+1 INTO next_revision FROM public.awards_application_version WHERE application_id=a.id;
  PERFORM public.awards_validate_display_snapshot(capture.form_snapshot,p_display);
  INSERT INTO public.awards_application_version(tenant_id,application_id,revision,form_snapshot,answer_snapshot,display_snapshot,attachment_manifest)
    VALUES(p_tenant,a.id,next_revision,capture.form_snapshot,capture.answer_snapshot,p_display,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'field_id',f.field_id,'cell_id',f.cell_id,'name',f.name,'sha256',f.digest) ORDER BY f.id),'[]')
        FROM public.awards_review_attachment f WHERE f.tenant_id=p_tenant AND f.submission_id=p_submission))
    RETURNING id INTO snapshot;
  INSERT INTO public.awards_amendment(tenant_id,application_id,application_version_id,submission_id,member_id,reason,access_id)
    VALUES(p_tenant,a.id,snapshot,p_submission,p_member,p_reason,access_id) RETURNING * INTO existing;
  UPDATE public.awards_application SET version=version+1 WHERE id=a.id;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,a.award_id,CASE WHEN p_member IS NULL THEN 'applicant_access' ELSE 'member' END,coalesce(p_member,access_id),'application.amended',a.id,p_reason,
      jsonb_build_object('application_version_id',snapshot,'revision',next_revision,'assignment_adoption','unchanged'));
  RETURN jsonb_build_object('id',existing.id,'applicationVersionId',snapshot,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.awards_record_amendment(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_record_amendment(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,boolean) TO service_role;
COMMIT;
