-- Follow-on to 20261127; never modify/rewrite an applied migration or history.
CREATE OR REPLACE FUNCTION public.survey_response_policy(p_type text,p_settings jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $fn$
  SELECT jsonb_build_array(coalesce(p_type,'standard'),
    coalesce(p_settings->>'response_identity','identified'),
    coalesce(p_settings->'anonymous_completion_version','null'::jsonb),
    coalesce(p_settings->'one_submission_per_respondent','false'::jsonb));
$fn$;
REVOKE ALL ON FUNCTION public.survey_response_policy(text,jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.guard_survey_form_response_policy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_snapshot jsonb;
BEGIN
  -- UPDATE already owns the form tuple lock. Never take acceptance's advisory
  -- lock here: advisory-then-row versus row-then-advisory would deadlock.
  IF public.survey_response_policy(NEW.form_type,NEW.survey_settings)
    IS DISTINCT FROM public.survey_response_policy(OLD.form_type,OLD.survey_settings)
    AND EXISTS(SELECT 1 FROM public.form_submission s
      WHERE s.tenant_id=OLD.tenant_id AND s.form_id=OLD.id AND s.survey_version_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Survey response policy is immutable after responses exist';
  END IF;
  IF (NEW.survey_settings->>'current_version') IS DISTINCT FROM (OLD.survey_settings->>'current_version')
    AND EXISTS(SELECT 1 FROM public.form_submission s
      WHERE s.tenant_id=OLD.tenant_id AND s.form_id=OLD.id AND s.survey_version_id IS NOT NULL) THEN
    SELECT v.survey_settings INTO v_snapshot FROM public.survey_version v
      WHERE v.tenant_id=NEW.tenant_id AND v.form_id=NEW.id
        AND v.version_number=(NEW.survey_settings->>'current_version')::integer;
    IF v_snapshot IS NULL OR public.survey_response_policy('survey',v_snapshot)
      IS DISTINCT FROM public.survey_response_policy(OLD.form_type,OLD.survey_settings) THEN
      RAISE EXCEPTION 'Published survey response policy is immutable after responses exist';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS guard_survey_form_response_policy ON public.form;
CREATE TRIGGER guard_survey_form_response_policy BEFORE UPDATE ON public.form
FOR EACH ROW EXECUTE FUNCTION public.guard_survey_form_response_policy();

CREATE OR REPLACE FUNCTION public.guard_survey_snapshot_response_policy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_form public.form;
BEGIN
  -- Published snapshots are immutable, even before their first response.
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Published survey snapshots are immutable'; END IF;
  -- Serializes allocation/publication against the first acceptance. Existing
  -- publish RPC can retain its version-allocation advisory lock.
  SELECT * INTO v_form FROM public.form WHERE id=NEW.form_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  IF v_form.id IS NULL OR v_form.form_type<>'survey' THEN RAISE EXCEPTION 'Survey snapshot requires survey form'; END IF;
  IF EXISTS(SELECT 1 FROM public.form_submission s
    WHERE s.tenant_id=NEW.tenant_id AND s.form_id=NEW.form_id AND s.survey_version_id IS NOT NULL)
    AND public.survey_response_policy('survey',NEW.survey_settings)
      IS DISTINCT FROM public.survey_response_policy(v_form.form_type,v_form.survey_settings) THEN
    RAISE EXCEPTION 'Published survey response policy is immutable after responses exist';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS guard_survey_snapshot_response_policy ON public.survey_version;
CREATE TRIGGER guard_survey_snapshot_response_policy BEFORE INSERT OR UPDATE OR DELETE ON public.survey_version
FOR EACH ROW EXECUTE FUNCTION public.guard_survey_snapshot_response_policy();

CREATE OR REPLACE FUNCTION public.guard_survey_acceptance_response_policy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_form public.form; v_settings jsonb;
BEGIN
  IF NEW.survey_version_id IS NULL THEN RETURN NEW; END IF;
  -- SHARE conflicts with both ordinary form UPDATE and snapshot insertion's
  -- UPDATE lock. Every survey acceptance (legacy RPC included) participates.
  SELECT * INTO v_form FROM public.form WHERE id=NEW.form_id AND tenant_id=NEW.tenant_id FOR SHARE;
  SELECT survey_settings INTO v_settings FROM public.survey_version
    WHERE id=NEW.survey_version_id AND form_id=NEW.form_id AND tenant_id=NEW.tenant_id;
  IF v_form.id IS NULL OR v_form.form_type<>'survey' OR v_settings IS NULL
    OR public.survey_response_policy('survey',v_settings)
      IS DISTINCT FROM public.survey_response_policy(v_form.form_type,v_form.survey_settings) THEN
    RAISE EXCEPTION 'Survey response policy changed; reload the published survey';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS guard_survey_acceptance_response_policy ON public.form_submission;
CREATE TRIGGER guard_survey_acceptance_response_policy BEFORE INSERT ON public.form_submission
FOR EACH ROW EXECUTE FUNCTION public.guard_survey_acceptance_response_policy();
REVOKE ALL ON FUNCTION public.guard_survey_form_response_policy(),
  public.guard_survey_snapshot_response_policy(),public.guard_survey_acceptance_response_policy()
  FROM PUBLIC,anon,authenticated;