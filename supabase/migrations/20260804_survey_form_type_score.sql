-- Task #3330: Survey form type & Score field.
-- Adds form_type + survey settings to form, an immutable survey version
-- snapshot table, a normalised survey answer table, and cached survey
-- scores on form_submission. Idempotent — safe to re-run.

-- 1) form: type discriminator + survey-level settings + audit trail
ALTER TABLE form ADD COLUMN IF NOT EXISTS form_type TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE form ADD COLUMN IF NOT EXISTS survey_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE form ADD COLUMN IF NOT EXISTS survey_audit_log JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_form_type_check') THEN
    ALTER TABLE form ADD CONSTRAINT form_form_type_check CHECK (form_type IN ('standard', 'survey'));
  END IF;
END $$;

-- 2) survey_version: immutable snapshot taken at publish time
CREATE TABLE IF NOT EXISTS survey_version (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  form_id UUID NOT NULL,
  version_number INTEGER NOT NULL,
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  pages JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  survey_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_by TEXT,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT survey_version_form_version_unique UNIQUE (form_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_survey_version_tenant_form ON survey_version (tenant_id, form_id);

-- 3) survey_answer: one row per scored answer, for reporting
CREATE TABLE IF NOT EXISTS survey_answer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  submission_id UUID NOT NULL,
  form_id UUID NOT NULL,
  survey_version_id UUID,
  field_id TEXT NOT NULL,
  reporting_name TEXT,
  reporting_category TEXT,
  raw_score NUMERIC,
  is_na BOOLEAN NOT NULL DEFAULT false,
  normalised_score NUMERIC,
  weight NUMERIC NOT NULL DEFAULT 1,
  weighted_contribution NUMERIC,
  included_in_overall BOOLEAN NOT NULL DEFAULT true,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT survey_answer_submission_field_unique UNIQUE (submission_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_survey_answer_tenant_form ON survey_answer (tenant_id, form_id);
CREATE INDEX IF NOT EXISTS idx_survey_answer_submission ON survey_answer (submission_id);
CREATE INDEX IF NOT EXISTS idx_survey_answer_tenant_category ON survey_answer (tenant_id, reporting_category) WHERE reporting_category IS NOT NULL;

-- 4) form_submission: cached overall scores + anonymity support
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS survey_version_id UUID;
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS survey_score_weighted NUMERIC;
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS survey_score_unweighted NUMERIC;
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS survey_respondent_key TEXT;
-- UNIQUE: database-enforced duplicate prevention — concurrent submissions
-- with the same respondent key cannot both insert (endpoint maps 23505 -> 409).
DROP INDEX IF EXISTS idx_form_submission_respondent_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_form_submission_respondent_key ON form_submission (form_id, survey_respondent_key) WHERE survey_respondent_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_form_submission_survey_version ON form_submission (survey_version_id) WHERE survey_version_id IS NOT NULL;

-- Atomic submission + answers write (Task #3330 review): the normalised
-- survey_answer rows ARE the survey result, so they must commit in the SAME
-- transaction as the form_submission row — no observable half-state.
CREATE OR REPLACE FUNCTION public.create_survey_submission(p_submission jsonb, p_answers jsonb DEFAULT '[]'::jsonb)
RETURNS SETOF public.form_submission
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.form_submission;
  v_cols text;
  v_ans jsonb;
  v_ans_cols text;
BEGIN
  SELECT string_agg(quote_ident(k), ',') INTO v_cols
  FROM jsonb_object_keys(p_submission) AS k
  JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = 'form_submission' AND c.column_name = k;
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'No valid form_submission columns supplied';
  END IF;
  EXECUTE format(
    'INSERT INTO public.form_submission (%s) SELECT %s FROM jsonb_populate_record(NULL::public.form_submission, $1) RETURNING *',
    v_cols, v_cols
  ) INTO v_row USING p_submission;

  FOR v_ans IN SELECT * FROM jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) LOOP
    v_ans := v_ans || jsonb_build_object('submission_id', v_row.id);
    SELECT string_agg(quote_ident(k), ',') INTO v_ans_cols
    FROM jsonb_object_keys(v_ans) AS k
    JOIN information_schema.columns c
      ON c.table_schema = 'public' AND c.table_name = 'survey_answer' AND c.column_name = k;
    EXECUTE format(
      'INSERT INTO public.survey_answer (%s) SELECT %s FROM jsonb_populate_record(NULL::public.survey_answer, $1)',
      v_ans_cols, v_ans_cols
    ) USING v_ans;
  END LOOP;

  RETURN NEXT v_row;
END;
$fn$;

-- Lock down the RPC: server-only (service_role). Without this, any direct
-- Supabase client could bypass snapshot validation/scoring/anonymity.
REVOKE ALL ON FUNCTION public.create_survey_submission(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_survey_submission(jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.create_survey_submission(jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_survey_submission(jsonb, jsonb) TO service_role;

-- Atomic, race-safe survey version allocation: number is taken from the
-- persisted MAX(version_number) under an advisory lock on the form, never
-- from the mutable survey_settings.current_version pointer.
CREATE OR REPLACE FUNCTION public.publish_survey_version(
  p_tenant_id uuid,
  p_form_id uuid,
  p_fields jsonb,
  p_pages jsonb,
  p_visibility_rules jsonb,
  p_survey_settings jsonb,
  p_published_by text
)
RETURNS public.survey_version
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_next int;
  v_row public.survey_version;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('survey_version:' || p_form_id::text));
  SELECT coalesce(max(version_number), 0) + 1 INTO v_next
  FROM public.survey_version
  WHERE form_id = p_form_id AND tenant_id = p_tenant_id;
  INSERT INTO public.survey_version
    (tenant_id, form_id, version_number, fields, pages, visibility_rules, survey_settings, published_by)
  VALUES
    (p_tenant_id, p_form_id, v_next,
     coalesce(p_fields, '[]'::jsonb), coalesce(p_pages, '[]'::jsonb),
     coalesce(p_visibility_rules, '[]'::jsonb),
     jsonb_set(coalesce(p_survey_settings, '{}'::jsonb), '{current_version}', to_jsonb(v_next)),
     p_published_by)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$fn$;
REVOKE ALL ON FUNCTION public.publish_survey_version(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_survey_version(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.publish_survey_version(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.publish_survey_version(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) TO service_role;

-- Idempotent + race-safe publish: the unchanged-config comparison now happens
-- INSIDE the same advisory lock as version allocation, so concurrent
-- identical publishes converge on one snapshot.
CREATE OR REPLACE FUNCTION public.publish_survey_version(
  p_tenant_id uuid,
  p_form_id uuid,
  p_fields jsonb,
  p_pages jsonb,
  p_visibility_rules jsonb,
  p_survey_settings jsonb,
  p_published_by text
)
RETURNS public.survey_version
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_next int;
  v_row public.survey_version;
  v_latest public.survey_version;
  v_new_settings jsonb;
  v_old_settings jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('survey_version:' || p_form_id::text));

  SELECT * INTO v_latest FROM public.survey_version
  WHERE form_id = p_form_id AND tenant_id = p_tenant_id
  ORDER BY version_number DESC LIMIT 1;

  IF v_latest.id IS NOT NULL THEN
    v_new_settings := (coalesce(p_survey_settings, '{}'::jsonb)) - 'status' - 'current_version';
    v_old_settings := (coalesce(v_latest.survey_settings, '{}'::jsonb)) - 'status' - 'current_version';
    IF coalesce(p_fields, '[]'::jsonb) = coalesce(v_latest.fields, '[]'::jsonb)
       AND coalesce(p_pages, '[]'::jsonb) = coalesce(v_latest.pages, '[]'::jsonb)
       AND coalesce(p_visibility_rules, '[]'::jsonb) = coalesce(v_latest.visibility_rules, '[]'::jsonb)
       AND v_new_settings = v_old_settings THEN
      RETURN v_latest;
    END IF;
  END IF;

  v_next := coalesce(v_latest.version_number, 0) + 1;
  INSERT INTO public.survey_version
    (tenant_id, form_id, version_number, fields, pages, visibility_rules, survey_settings, published_by)
  VALUES
    (p_tenant_id, p_form_id, v_next,
     coalesce(p_fields, '[]'::jsonb), coalesce(p_pages, '[]'::jsonb),
     coalesce(p_visibility_rules, '[]'::jsonb),
     jsonb_set(coalesce(p_survey_settings, '{}'::jsonb), '{current_version}', to_jsonb(v_next)),
     p_published_by)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$fn$;

-- Fully atomic publish: idempotence check, version allocation, AND the form
-- pointer/status/audit update all inside one advisory-locked transaction, so
-- concurrent publishes can never leave current_version inconsistent with the
-- form config or drop audit entries.
CREATE OR REPLACE FUNCTION public.publish_survey(
  p_tenant_id uuid,
  p_form_id uuid,
  p_fields jsonb,
  p_pages jsonb,
  p_visibility_rules jsonb,
  p_survey_settings jsonb,
  p_published_by text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_next int;
  v_row public.survey_version;
  v_latest public.survey_version;
  v_unchanged boolean := false;
  v_settings jsonb;
  v_audit jsonb;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('survey_version:' || p_form_id::text));

  SELECT * INTO v_latest FROM public.survey_version
  WHERE form_id = p_form_id AND tenant_id = p_tenant_id
  ORDER BY version_number DESC LIMIT 1;

  IF v_latest.id IS NOT NULL
     AND coalesce(p_fields, '[]'::jsonb) = coalesce(v_latest.fields, '[]'::jsonb)
     AND coalesce(p_pages, '[]'::jsonb) = coalesce(v_latest.pages, '[]'::jsonb)
     AND coalesce(p_visibility_rules, '[]'::jsonb) = coalesce(v_latest.visibility_rules, '[]'::jsonb)
     AND ((coalesce(p_survey_settings, '{}'::jsonb)) - 'status' - 'current_version')
       = ((coalesce(v_latest.survey_settings, '{}'::jsonb)) - 'status' - 'current_version') THEN
    v_row := v_latest;
    v_unchanged := true;
  ELSE
    v_next := coalesce(v_latest.version_number, 0) + 1;
    INSERT INTO public.survey_version
      (tenant_id, form_id, version_number, fields, pages, visibility_rules, survey_settings, published_by)
    VALUES
      (p_tenant_id, p_form_id, v_next,
       coalesce(p_fields, '[]'::jsonb), coalesce(p_pages, '[]'::jsonb),
       coalesce(p_visibility_rules, '[]'::jsonb),
       jsonb_set(
         jsonb_set(coalesce(p_survey_settings, '{}'::jsonb), '{status}', '"published"'),
         '{current_version}', to_jsonb(v_next)),
       p_published_by)
    RETURNING * INTO v_row;
  END IF;

  v_settings := jsonb_set(
    jsonb_set(coalesce(p_survey_settings, '{}'::jsonb), '{status}', '"published"'),
    '{current_version}', to_jsonb(v_row.version_number));

  SELECT coalesce(survey_audit_log, '[]'::jsonb) INTO v_audit
  FROM public.form WHERE id = p_form_id AND tenant_id = p_tenant_id FOR UPDATE;

  IF v_unchanged THEN
    v_audit := v_audit || jsonb_build_array(jsonb_build_object(
      'at', v_now, 'actor', p_published_by, 'action', 'publish',
      'detail', 'Re-published version ' || v_row.version_number || ' (unchanged)'));
  ELSE
    v_audit := v_audit || jsonb_build_array(
      jsonb_build_object('at', v_now, 'actor', p_published_by, 'action', 'publish',
        'detail', 'Published version ' || v_row.version_number),
      jsonb_build_object('at', v_now, 'actor', p_published_by, 'action', 'version',
        'detail', 'Version ' || v_row.version_number || ' snapshot created'));
  END IF;

  UPDATE public.form
  SET survey_settings = v_settings, survey_audit_log = v_audit
  WHERE id = p_form_id AND tenant_id = p_tenant_id;

  RETURN jsonb_build_object(
    'version_id', v_row.id,
    'version_number', v_row.version_number,
    'unchanged', v_unchanged,
    'survey_settings', v_settings,
    'survey_audit_log', v_audit
  );
END;
$fn$;
REVOKE ALL ON FUNCTION public.publish_survey(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_survey(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.publish_survey(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.publish_survey(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text) TO service_role;

-- DB-boundary immutability for survey tables: only the backend service role
-- may write; snapshots are append-only even for it (no UPDATE/DELETE grant).
ALTER TABLE public.survey_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_answer ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.survey_version FROM anon, authenticated;
REVOKE ALL ON public.survey_answer FROM anon, authenticated;
-- service_role bypasses RLS; with no policies defined, anon/authenticated
-- get nothing even if future grants reappear.
CREATE OR REPLACE FUNCTION public.survey_version_immutable()
RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN
  RAISE EXCEPTION 'survey_version rows are immutable';
END;
$t$;
DROP TRIGGER IF EXISTS trg_survey_version_immutable ON public.survey_version;
CREATE TRIGGER trg_survey_version_immutable
  BEFORE UPDATE OR DELETE ON public.survey_version
  FOR EACH ROW EXECUTE FUNCTION public.survey_version_immutable();

-- publish_survey: validate the target inside the SECURITY DEFINER boundary.
CREATE OR REPLACE FUNCTION public.publish_survey(
  p_tenant_id uuid,
  p_form_id uuid,
  p_fields jsonb,
  p_pages jsonb,
  p_visibility_rules jsonb,
  p_survey_settings jsonb,
  p_published_by text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_next int;
  v_row public.survey_version;
  v_latest public.survey_version;
  v_unchanged boolean := false;
  v_settings jsonb;
  v_audit jsonb;
  v_form_type text;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('survey_version:' || p_form_id::text));

  -- Validate + lock the target form: must exist in this tenant and be a survey.
  SELECT form_type, coalesce(survey_audit_log, '[]'::jsonb) INTO v_form_type, v_audit
  FROM public.form WHERE id = p_form_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF v_form_type IS NULL THEN
    RAISE EXCEPTION 'Form not found for tenant';
  END IF;
  IF v_form_type <> 'survey' THEN
    RAISE EXCEPTION 'Form is not a survey';
  END IF;

  SELECT * INTO v_latest FROM public.survey_version
  WHERE form_id = p_form_id AND tenant_id = p_tenant_id
  ORDER BY version_number DESC LIMIT 1;

  IF v_latest.id IS NOT NULL
     AND coalesce(p_fields, '[]'::jsonb) = coalesce(v_latest.fields, '[]'::jsonb)
     AND coalesce(p_pages, '[]'::jsonb) = coalesce(v_latest.pages, '[]'::jsonb)
     AND coalesce(p_visibility_rules, '[]'::jsonb) = coalesce(v_latest.visibility_rules, '[]'::jsonb)
     AND ((coalesce(p_survey_settings, '{}'::jsonb)) - 'status' - 'current_version')
       = ((coalesce(v_latest.survey_settings, '{}'::jsonb)) - 'status' - 'current_version') THEN
    v_row := v_latest;
    v_unchanged := true;
  ELSE
    v_next := coalesce(v_latest.version_number, 0) + 1;
    INSERT INTO public.survey_version
      (tenant_id, form_id, version_number, fields, pages, visibility_rules, survey_settings, published_by)
    VALUES
      (p_tenant_id, p_form_id, v_next,
       coalesce(p_fields, '[]'::jsonb), coalesce(p_pages, '[]'::jsonb),
       coalesce(p_visibility_rules, '[]'::jsonb),
       jsonb_set(
         jsonb_set(coalesce(p_survey_settings, '{}'::jsonb), '{status}', '"published"'),
         '{current_version}', to_jsonb(v_next)),
       p_published_by)
    RETURNING * INTO v_row;
  END IF;

  v_settings := jsonb_set(
    jsonb_set(coalesce(p_survey_settings, '{}'::jsonb), '{status}', '"published"'),
    '{current_version}', to_jsonb(v_row.version_number));

  IF v_unchanged THEN
    v_audit := v_audit || jsonb_build_array(jsonb_build_object(
      'at', v_now, 'actor', p_published_by, 'action', 'publish',
      'detail', 'Re-published version ' || v_row.version_number || ' (unchanged)'));
  ELSE
    v_audit := v_audit || jsonb_build_array(
      jsonb_build_object('at', v_now, 'actor', p_published_by, 'action', 'publish',
        'detail', 'Published version ' || v_row.version_number),
      jsonb_build_object('at', v_now, 'actor', p_published_by, 'action', 'version',
        'detail', 'Version ' || v_row.version_number || ' snapshot created'));
  END IF;

  UPDATE public.form
  SET survey_settings = v_settings, survey_audit_log = v_audit
  WHERE id = p_form_id AND tenant_id = p_tenant_id;

  RETURN jsonb_build_object(
    'version_id', v_row.id,
    'version_number', v_row.version_number,
    'unchanged', v_unchanged,
    'survey_settings', v_settings,
    'survey_audit_log', v_audit
  );
END;
$fn$;

-- Harden create_survey_submission: explicit column allowlists (no dynamic
-- catalogue-driven inserts) and tenant/form/version linkage validated inside
-- the SECURITY DEFINER boundary.
CREATE OR REPLACE FUNCTION public.create_survey_submission(p_submission jsonb, p_answers jsonb DEFAULT '[]'::jsonb)
RETURNS SETOF public.form_submission
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.form_submission;
  v_ans jsonb;
  v_cols text;
  v_tenant uuid := (p_submission->>'tenant_id')::uuid;
  v_form uuid := (p_submission->>'form_id')::uuid;
  v_version uuid := (p_submission->>'survey_version_id')::uuid;
  v_form_type text;
  v_bad text;
  c_allow constant text[] := ARRAY[
    'form_id','form_name','submitted_by_email','submitted_by_name',
    'submission_data','created_date','tenant_id','contract_instance_id',
    'organization_id','created_organization_id','event_id','vacancy_id',
    'brief_id','role_id','member_id','created_member_id','ip_address',
    'user_agent','metadata','idempotency_key','survey_version_id',
    'survey_score_weighted','survey_score_unweighted','is_anonymous',
    'survey_respondent_key','source','status'
  ];
  c_ans_allow constant text[] := ARRAY[
    'tenant_id','submission_id','form_id','survey_version_id','field_id',
    'reporting_name','reporting_category','raw_score','is_na',
    'normalised_score','weight','weighted_contribution','included_in_overall'
  ];
BEGIN
  -- Reject any key outside the explicit allowlist (never silently drop —
  -- a rejected key means a caller bug or an injection attempt).
  SELECT k INTO v_bad FROM jsonb_object_keys(p_submission) AS k
  WHERE k <> ALL (c_allow) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Disallowed form_submission column: %', v_bad;
  END IF;

  -- Linkage validation: tenant + survey form + version must be consistent.
  IF v_tenant IS NULL OR v_form IS NULL OR v_version IS NULL THEN
    RAISE EXCEPTION 'tenant_id, form_id and survey_version_id are required';
  END IF;
  SELECT form_type INTO v_form_type FROM public.form
  WHERE id = v_form AND tenant_id = v_tenant;
  IF v_form_type IS NULL THEN
    RAISE EXCEPTION 'Form not found for tenant';
  END IF;
  IF v_form_type <> 'survey' THEN
    RAISE EXCEPTION 'Form is not a survey';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.survey_version
    WHERE id = v_version AND form_id = v_form AND tenant_id = v_tenant
  ) THEN
    RAISE EXCEPTION 'survey_version does not belong to this form/tenant';
  END IF;

  SELECT string_agg(quote_ident(k), ',') INTO v_cols
  FROM jsonb_object_keys(p_submission) AS k;
  EXECUTE format(
    'INSERT INTO public.form_submission (%s) SELECT %s FROM jsonb_populate_record(NULL::public.form_submission, $1) RETURNING *',
    v_cols, v_cols
  ) INTO v_row USING p_submission;

  FOR v_ans IN SELECT * FROM jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) LOOP
    SELECT k INTO v_bad FROM jsonb_object_keys(v_ans) AS k
    WHERE k <> ALL (c_ans_allow) LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'Disallowed survey_answer column: %', v_bad;
    END IF;
    IF (v_ans->>'tenant_id')::uuid IS DISTINCT FROM v_tenant
       OR (v_ans->>'form_id')::uuid IS DISTINCT FROM v_form
       OR (v_ans->>'survey_version_id')::uuid IS DISTINCT FROM v_version THEN
      RAISE EXCEPTION 'survey_answer linkage mismatch';
    END IF;
    v_ans := v_ans || jsonb_build_object('submission_id', v_row.id);
    SELECT string_agg(quote_ident(k), ',') INTO v_cols
    FROM jsonb_object_keys(v_ans) AS k;
    EXECUTE format(
      'INSERT INTO public.survey_answer (%s) SELECT %s FROM jsonb_populate_record(NULL::public.survey_answer, $1)',
      v_cols, v_cols
    ) USING v_ans;
  END LOOP;

  RETURN NEXT v_row;
END;
$fn$;
