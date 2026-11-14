BEGIN;
-- Historical revisions must identify the evidence scored, even after the
-- assignment explicitly adopts a later application snapshot.
ALTER TABLE public.assessment_revision ADD COLUMN application_version_id uuid;
ALTER TABLE public.assessment_revision ADD COLUMN criteria_version_id uuid;
CREATE FUNCTION public.assessment_revision_provenance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE assignment public.assessment_assignment;
BEGIN
  SELECT * INTO assignment FROM public.assessment_assignment WHERE tenant_id=NEW.tenant_id AND id=NEW.assignment_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assessment assignment unavailable'; END IF;
  IF NEW.application_version_id IS NOT NULL AND NEW.application_version_id IS DISTINCT FROM assignment.application_version_id
    OR NEW.criteria_version_id IS NOT NULL AND NEW.criteria_version_id IS DISTINCT FROM assignment.criteria_version_id THEN
    RAISE EXCEPTION 'Assessment evidence does not match assignment';
  END IF;
  NEW.application_version_id:=assignment.application_version_id;
  NEW.criteria_version_id:=assignment.criteria_version_id;
  RETURN NEW;
END $$;
CREATE TRIGGER assessment_revision_provenance BEFORE INSERT ON public.assessment_revision
FOR EACH ROW EXECUTE FUNCTION public.assessment_revision_provenance();
REVOKE ALL ON FUNCTION public.assessment_revision_provenance() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.assessment_adopt_snapshot(p_tenant uuid,p_round uuid,p_application uuid,p_snapshot uuid,
  p_expected jsonb,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round; assignment public.assessment_assignment; revision_number integer; changed integer:=0; expected jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0
    OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Adoption authority and exact assignment versions required'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round unavailable'; END IF;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=r.award_id FOR UPDATE;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR UPDATE;
  PERFORM public.awards_require_active_review(p_tenant,r.award_id);
  IF r.state NOT IN ('draft','judging') THEN RAISE EXCEPTION 'Reopen the round before adopting revised evidence'; END IF;
  PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND award_id=r.award_id AND id=p_application FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.awards_application_version WHERE tenant_id=p_tenant AND application_id=p_application AND id=p_snapshot) THEN
    RAISE EXCEPTION 'Application snapshot unavailable'; END IF;
  IF public.assessment_has_active_decisions(p_tenant,p_round,p_application) THEN
    RAISE EXCEPTION 'Reopen downstream decisions before adopting revised evidence'; END IF;
  SELECT coalesce(jsonb_object_agg(id::text,version),'{}') INTO expected FROM public.assessment_assignment
    WHERE tenant_id=p_tenant AND round_id=p_round AND application_id=p_application;
  IF expected IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Assignments changed' USING ERRCODE='40001'; END IF;
  FOR assignment IN SELECT * FROM public.assessment_assignment WHERE tenant_id=p_tenant AND round_id=p_round AND application_id=p_application ORDER BY id FOR UPDATE LOOP
    IF assignment.application_version_id=p_snapshot THEN CONTINUE; END IF;
    -- Never rewrite an older revision whose original evidence was not pinned.
    IF EXISTS(SELECT 1 FROM public.assessment_revision WHERE assignment_id=assignment.id
      AND (application_version_id IS NULL OR criteria_version_id IS NULL)) THEN
      RAISE EXCEPTION 'Historical assessment provenance requires an authorised migration before adoption'; END IF;
    UPDATE public.assessment_assignment SET application_version_id=p_snapshot,version=version+1 WHERE id=assignment.id;
    SELECT coalesce(max(revision),0)+1 INTO revision_number FROM public.assessment_revision WHERE assignment_id=assignment.id;
    INSERT INTO public.assessment_revision(tenant_id,assignment_id,revision,state,answers)
      VALUES(p_tenant,assignment.id,revision_number,'reopened','{}');
    INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
      VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'assessment.snapshot_adopted',assignment.id,p_reason,
        jsonb_build_object('previous_snapshot',assignment.application_version_id,'snapshot',p_snapshot,'assessment_revision',revision_number));
    changed:=changed+1;
  END LOOP;
  RETURN jsonb_build_object('changed',changed,'applicationVersionId',p_snapshot);
END $$;
REVOKE ALL ON FUNCTION public.assessment_adopt_snapshot(uuid,uuid,uuid,uuid,jsonb,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_adopt_snapshot(uuid,uuid,uuid,uuid,jsonb,text,uuid,text) TO service_role;
COMMIT;
