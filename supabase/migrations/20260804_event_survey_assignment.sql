-- Task #3331: Survey event assignments.
-- One reusable Survey Form can be assigned to many events (simple + complex)
-- without duplicating the form. Every response resolves its event SERVER-SIDE
-- from the assignment (never a client-supplied event id).

CREATE TABLE IF NOT EXISTS public.event_survey_assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  form_id UUID NOT NULL REFERENCES public.form(id) ON DELETE CASCADE,
  -- The survey version that was current when the assignment was created
  -- (reference only — the public flow always serves the CURRENT published
  -- snapshot, and each response stamps the version actually served).
  survey_version_id UUID REFERENCES public.survey_version(id) ON DELETE SET NULL,
  survey_version_number INTEGER,
  -- Event linkage: exactly one of the two event columns is set, discriminated
  -- by event_type. FKs are ON DELETE SET NULL so deleting an event never
  -- breaks historic results — the title snapshot keeps assignments reportable.
  event_type TEXT NOT NULL DEFAULT 'event' CHECK (event_type IN ('event', 'complex_event')),
  event_id UUID REFERENCES public.event(id) ON DELETE SET NULL,
  complex_event_id UUID REFERENCES public.complex_event(id) ON DELETE SET NULL,
  event_title TEXT,
  event_start_date TIMESTAMPTZ,
  -- Response window + lifecycle
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  access_mode TEXT NOT NULL DEFAULT 'public' CHECK (access_mode IN ('public', 'authenticated')),
  -- Unique unguessable token that drives the public assignment URL.
  token TEXT NOT NULL,
  -- Response tracking (denormalised, maintained by the submission endpoint).
  response_count INTEGER NOT NULL DEFAULT 0,
  first_response_at TIMESTAMPTZ,
  last_response_at TIMESTAMPTZ,
  -- Audit
  created_by TEXT,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_by TEXT,
  archived_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS event_survey_assignment_token_key
  ON public.event_survey_assignment (token);
CREATE INDEX IF NOT EXISTS event_survey_assignment_tenant_form_idx
  ON public.event_survey_assignment (tenant_id, form_id);
CREATE INDEX IF NOT EXISTS event_survey_assignment_tenant_event_idx
  ON public.event_survey_assignment (tenant_id, event_id);
CREATE INDEX IF NOT EXISTS event_survey_assignment_tenant_complex_event_idx
  ON public.event_survey_assignment (tenant_id, complex_event_id);

-- Responses store the assignment they arrived through. ON DELETE SET NULL is a
-- safety net only — assignments with responses are archive-only (enforced in
-- the API layer).
ALTER TABLE public.form_submission
  ADD COLUMN IF NOT EXISTS survey_assignment_id UUID REFERENCES public.event_survey_assignment(id) ON DELETE SET NULL;

-- Durable complex-event attribution: form_submission.event_id is a
-- simple-event FK, so complex-event survey responses get their own column
-- (stamped server-side from the resolved assignment, like event_id).
ALTER TABLE public.form_submission
  ADD COLUMN IF NOT EXISTS complex_event_id UUID REFERENCES public.complex_event(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS form_submission_survey_assignment_idx
  ON public.form_submission (survey_assignment_id)
  WHERE survey_assignment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS form_submission_complex_event_idx
  ON public.form_submission (complex_event_id)
  WHERE complex_event_id IS NOT NULL;

-- Extend the hardened create_survey_submission allowlist with
-- survey_assignment_id (stamped server-side from the resolved assignment).
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
  v_assignment uuid := (p_submission->>'survey_assignment_id')::uuid;
  v_form_type text;
  v_bad text;
  c_allow constant text[] := ARRAY[
    'form_id','form_name','submitted_by_email','submitted_by_name',
    'submission_data','created_date','tenant_id','contract_instance_id',
    'organization_id','created_organization_id','event_id','vacancy_id',
    'brief_id','role_id','member_id','created_member_id','ip_address',
    'user_agent','metadata','idempotency_key','survey_version_id',
    'survey_score_weighted','survey_score_unweighted','is_anonymous',
    'survey_respondent_key','source','status','survey_assignment_id',
    'complex_event_id'
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
  -- Assignment linkage: when present, it must belong to the same tenant+form.
  IF v_assignment IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.event_survey_assignment
    WHERE id = v_assignment AND form_id = v_form AND tenant_id = v_tenant
  ) THEN
    RAISE EXCEPTION 'survey_assignment does not belong to this form/tenant';
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

-- Re-lock the replaced RPC: server-only (service_role). CREATE OR REPLACE
-- keeps existing grants on an already-deployed function, but a fresh
-- environment applying this migration standalone would otherwise fall back
-- to default (PUBLIC-executable) privileges and bypass server-side
-- validation/window/token checks.
REVOKE ALL ON FUNCTION public.create_survey_submission(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_survey_submission(jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.create_survey_submission(jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_survey_submission(jsonb, jsonb) TO service_role;

-- Maintain response tracking transactionally with the counted rows: a trigger
-- on form_submission keeps response_count / first/last response timestamps
-- accurate on the assignment row without a separate racy UPDATE.
CREATE OR REPLACE FUNCTION public.bump_event_survey_assignment_responses()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.survey_assignment_id IS NOT NULL THEN
    UPDATE public.event_survey_assignment
    SET response_count = response_count + 1,
        first_response_at = COALESCE(first_response_at, NEW.created_date, now()),
        last_response_at = GREATEST(COALESCE(last_response_at, '-infinity'::timestamptz), COALESCE(NEW.created_date, now())),
        updated_at = now()
    WHERE id = NEW.survey_assignment_id;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Trigger functions are not directly callable, but lock it down anyway so no
-- role can EXECUTE it out of band.
REVOKE ALL ON FUNCTION public.bump_event_survey_assignment_responses() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_event_survey_assignment_responses() FROM anon;
REVOKE ALL ON FUNCTION public.bump_event_survey_assignment_responses() FROM authenticated;

DROP TRIGGER IF EXISTS trg_bump_event_survey_assignment_responses ON public.form_submission;
CREATE TRIGGER trg_bump_event_survey_assignment_responses
AFTER INSERT ON public.form_submission
FOR EACH ROW
EXECUTE FUNCTION public.bump_event_survey_assignment_responses();

-- Archive-not-delete enforced at the DATABASE boundary, not just in the API:
-- an assignment that has responses can never be deleted — not directly, and
-- not via the form_id ON DELETE CASCADE (deleting a survey form whose
-- assignments have responses aborts the whole delete, preserving historic
-- form_submission.survey_assignment_id attribution for reporting).
-- Response-less assignments still cascade cleanly with their form.
CREATE OR REPLACE FUNCTION public.guard_event_survey_assignment_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF COALESCE(OLD.response_count, 0) > 0
     OR EXISTS (SELECT 1 FROM public.form_submission WHERE survey_assignment_id = OLD.id) THEN
    RAISE EXCEPTION 'event_survey_assignment % has responses; archive instead of deleting', OLD.id
      USING ERRCODE = '55006'; -- object_in_use
  END IF;
  RETURN OLD;
END;
$fn$;

REVOKE ALL ON FUNCTION public.guard_event_survey_assignment_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_event_survey_assignment_delete() FROM anon;
REVOKE ALL ON FUNCTION public.guard_event_survey_assignment_delete() FROM authenticated;

DROP TRIGGER IF EXISTS trg_guard_event_survey_assignment_delete ON public.event_survey_assignment;
CREATE TRIGGER trg_guard_event_survey_assignment_delete
BEFORE DELETE ON public.event_survey_assignment
FOR EACH ROW
EXECUTE FUNCTION public.guard_event_survey_assignment_delete();
