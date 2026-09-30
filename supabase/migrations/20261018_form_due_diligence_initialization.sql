-- Task #4375: prospective, durable initialisation of due-diligence workflows.
-- This migration intentionally contains no UPDATE/INSERT SELECT over existing
-- form_submission rows.  Paid eligibility begins only with rows inserted after
-- this trigger is installed.

CREATE TABLE IF NOT EXISTS public.form_due_diligence_initialization (
  form_submission_id UUID PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  paid_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'processing', 'failed', 'completed', 'requires_attention')),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  due_diligence_submission_id UUID REFERENCES public.form_submission_due_diligence(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.form_due_diligence_action_checkpoint (
  form_submission_due_diligence_id UUID NOT NULL
    REFERENCES public.form_submission_due_diligence(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  action_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status = 'completed'),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (form_submission_due_diligence_id, action_key)
);

CREATE INDEX IF NOT EXISTS form_due_diligence_initialization_paid_work_idx
  ON public.form_due_diligence_initialization (next_attempt_at, created_at, form_submission_id)
  WHERE paid_eligible AND state IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS form_due_diligence_action_checkpoint_tenant_idx
  ON public.form_due_diligence_action_checkpoint (tenant_id, form_submission_due_diligence_id);

CREATE OR REPLACE FUNCTION public.mark_paid_form_due_diligence_eligible()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_form public.form%ROWTYPE;
  v_anonymous BOOLEAN;
BEGIN
  -- This is an AFTER INSERT trigger by design.  A payment state update must
  -- never retrospectively enqueue older submissions.
  IF NEW.payment_status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_form
    FROM public.form
   WHERE id = NEW.form_id
     AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR COALESCE(v_form.due_diligence_required, FALSE) IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Persisted is_anonymous is authoritative for new survey submissions.  The
  -- current form setting is also checked as a defence for insert paths which
  -- pre-date that column; neither client input nor an email is inspected.
  v_anonymous := COALESCE(NEW.is_anonymous, FALSE)
    OR (
      COALESCE(v_form.form_type, '') = 'survey'
      AND COALESCE(v_form.survey_settings->>'response_identity', 'identified') <> 'identified'
    );
  IF v_anonymous THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.form_due_diligence_initialization
    (form_submission_id, tenant_id, paid_eligible, state)
  VALUES (NEW.id, NEW.tenant_id, TRUE, 'queued')
  ON CONFLICT (form_submission_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_mark_paid_form_due_diligence_eligible ON public.form_submission;
CREATE TRIGGER trigger_mark_paid_form_due_diligence_eligible
AFTER INSERT ON public.form_submission
FOR EACH ROW EXECUTE FUNCTION public.mark_paid_form_due_diligence_eligible();

CREATE OR REPLACE FUNCTION public.claim_form_due_diligence_initialization(
  p_tenant_id UUID,
  p_submission_id UUID,
  p_lease_token UUID,
  p_paid_only BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission public.form_submission%ROWTYPE;
  v_form public.form%ROWTYPE;
  v_lifecycle public.form_due_diligence_initialization%ROWTYPE;
  v_dd public.form_submission_due_diligence%ROWTYPE;
  v_stages JSONB;
  v_initial_stage_id TEXT;
  v_is_anonymous BOOLEAN;
BEGIN
  SELECT * INTO v_submission
    FROM public.form_submission
   WHERE id = p_submission_id AND tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', FALSE, 'code', 'SUBMISSION_NOT_FOUND');
  END IF;

  SELECT * INTO v_form FROM public.form
   WHERE id = v_submission.form_id AND tenant_id = p_tenant_id;
  IF NOT FOUND OR COALESCE(v_form.due_diligence_required, FALSE) IS NOT TRUE THEN
    RETURN jsonb_build_object('claimed', FALSE, 'code', 'FORM_NOT_ELIGIBLE');
  END IF;
  v_is_anonymous := COALESCE(v_submission.is_anonymous, FALSE)
    OR (COALESCE(v_form.form_type, '') = 'survey'
      AND COALESCE(v_form.survey_settings->>'response_identity', 'identified') <> 'identified');
  IF v_is_anonymous THEN
    RETURN jsonb_build_object('claimed', FALSE, 'code', 'ANONYMOUS_SUBMISSION');
  END IF;

  SELECT * INTO v_lifecycle
    FROM public.form_due_diligence_initialization
   WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id
   FOR UPDATE;

  -- Payment rows are exclusively owned by the prospective INSERT marker.
  -- In particular this prevents a normal/manual caller from creating a
  -- lifecycle row for a historical pending, failed, or paid row.
  IF p_paid_only THEN
    IF NOT FOUND OR v_lifecycle.paid_eligible IS NOT TRUE THEN
      RETURN jsonb_build_object('claimed', FALSE, 'code', 'NOT_PROSPECTIVELY_MARKED');
    END IF;
    IF NOT (
      v_submission.payment_status = 'paid'
      OR (
        v_submission.payment_status = 'setup_complete'
        AND v_submission.payment_provider IN ('stripe_monthly_card', 'gocardless_monthly_dd')
        AND (
          (v_submission.payment_provider = 'stripe_monthly_card'
            AND v_submission.payment_meta->'monthly_card_state'->>'status' = 'done')
          OR
          (v_submission.payment_provider = 'gocardless_monthly_dd'
            AND v_submission.payment_meta->'monthly_dd_state'->>'status' = 'done')
        )
      )
    ) THEN
      RETURN jsonb_build_object('claimed', FALSE, 'code', 'PAYMENT_NOT_SUCCESSFUL');
    END IF;
  ELSIF v_submission.payment_status IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', FALSE, 'code', 'PAYMENT_LIFECYCLE_REQUIRES_MARKER');
  ELSIF NOT FOUND THEN
    INSERT INTO public.form_due_diligence_initialization
      (form_submission_id, tenant_id, paid_eligible, state)
    VALUES (p_submission_id, p_tenant_id, FALSE, 'queued');
    SELECT * INTO v_lifecycle
      FROM public.form_due_diligence_initialization
     WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id
     FOR UPDATE;
  END IF;
  IF v_lifecycle.state = 'completed' THEN
    RETURN jsonb_build_object('claimed', FALSE, 'code', 'ALREADY_COMPLETED');
  END IF;
  -- Never automatically take over a live/interrupted lease.  A lease that
  -- expires may have performed an external effect before crashing, so it is
  -- intentionally surfaced as requires_attention instead of replayed.
  IF v_lifecycle.state IN ('processing', 'requires_attention') THEN
    RETURN jsonb_build_object('claimed', FALSE, 'code', 'REQUIRES_ATTENTION');
  END IF;
  IF v_lifecycle.state = 'failed' AND v_lifecycle.next_attempt_at > NOW() THEN
    RETURN jsonb_build_object('claimed', FALSE, 'code', 'RETRY_NOT_DUE');
  END IF;

  SELECT cfg.workflow_stages INTO v_stages
    FROM public.form_due_diligence_config cfg
   WHERE cfg.form_id = v_form.id AND cfg.tenant_id = p_tenant_id
   LIMIT 1;
  v_stages := COALESCE(v_stages, '[]'::JSONB);
  SELECT stage->>'id' INTO v_initial_stage_id
    FROM jsonb_array_elements(v_stages) stage
   WHERE COALESCE((stage->>'is_initial')::BOOLEAN, FALSE)
   LIMIT 1;
  IF v_initial_stage_id IS NULL THEN
    SELECT stage->>'id' INTO v_initial_stage_id FROM jsonb_array_elements(v_stages) stage LIMIT 1;
  END IF;
  v_initial_stage_id := COALESCE(v_initial_stage_id, 'new');

  INSERT INTO public.form_submission_due_diligence (
    form_submission_id, tenant_id, application_uid, original_form_values,
    reviewed_form_values, field_review_status, workflow_status, history_log
  ) VALUES (
    p_submission_id, p_tenant_id, 'DD-' || gen_random_uuid()::TEXT,
    COALESCE(v_submission.submission_data, '{}'::JSONB),
    COALESCE(v_submission.submission_data, '{}'::JSONB), '{}'::JSONB,
    v_initial_stage_id,
    jsonb_build_array(jsonb_build_object(
      'timestamp', NOW(), 'event_type', 'submission_received', 'user_email', 'System',
      'details', jsonb_build_object(
        'form_submission_id', p_submission_id, 'initial_status', v_initial_stage_id
      )
    ))
  )
  ON CONFLICT (form_submission_id) DO NOTHING;

  SELECT * INTO v_dd FROM public.form_submission_due_diligence
   WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id;
  -- Retries must use the stage persisted with the DD record, not a workflow
  -- configuration that an administrator happened to edit after first claim.
  v_initial_stage_id := COALESCE(v_dd.workflow_status, v_initial_stage_id);
  UPDATE public.form_due_diligence_initialization
     SET state = 'processing', lease_token = p_lease_token,
         lease_expires_at = NOW() + INTERVAL '10 minutes',
         due_diligence_submission_id = v_dd.id, last_error = NULL, updated_at = NOW()
   WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id;

  RETURN jsonb_build_object(
    'claimed', TRUE, 'form_id', v_submission.form_id,
    'initial_stage_id', v_initial_stage_id, 'dd_submission', to_jsonb(v_dd)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_form_due_diligence_actions(
  p_tenant_id UUID, p_submission_id UUID, p_lease_token UUID, p_action_keys TEXT[]
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_dd_id UUID;
BEGIN
  SELECT due_diligence_submission_id INTO v_dd_id
    FROM public.form_due_diligence_initialization
   WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id
     AND state = 'processing' AND lease_token = p_lease_token
   FOR UPDATE;
  IF NOT FOUND OR v_dd_id IS NULL THEN
    RAISE EXCEPTION 'due-diligence initialization lease is not held' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.form_due_diligence_action_checkpoint
    (form_submission_due_diligence_id, tenant_id, action_key)
  SELECT v_dd_id, p_tenant_id, action_key FROM unnest(COALESCE(p_action_keys, ARRAY[]::TEXT[])) action_key
  ON CONFLICT (form_submission_due_diligence_id, action_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_form_due_diligence_initialization(
  p_tenant_id UUID, p_submission_id UUID, p_lease_token UUID,
  p_succeeded BOOLEAN, p_error TEXT DEFAULT NULL, p_ambiguous BOOLEAN DEFAULT FALSE
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.form_due_diligence_initialization
     SET state = CASE WHEN p_succeeded THEN 'completed'
                      WHEN p_ambiguous THEN 'requires_attention'
                      ELSE 'failed' END,
         lease_token = NULL, lease_expires_at = NULL,
         attempt_count = CASE WHEN p_succeeded THEN attempt_count ELSE attempt_count + 1 END,
         next_attempt_at = CASE WHEN p_succeeded THEN NOW()
           ELSE NOW() + make_interval(secs => LEAST(3600, 60 * POWER(2, LEAST(attempt_count, 6))::INTEGER))
         END,
         last_error = CASE WHEN p_succeeded THEN NULL ELSE LEFT(COALESCE(p_error, 'initialization failed'), 2000) END,
         updated_at = NOW()
   WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id
     AND state = 'processing' AND lease_token = p_lease_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'due-diligence initialization lease is not held' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Claim RPC failures occur before an external action begins. The marker
-- survives a rolled-back claim transaction, so record bounded exponential
-- backoff separately without ever creating a row for unmarked history.
CREATE OR REPLACE FUNCTION public.record_form_due_diligence_claim_failure(
  p_tenant_id UUID, p_submission_id UUID, p_error TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.form_due_diligence_initialization
     SET state = 'failed',
         attempt_count = attempt_count + 1,
         next_attempt_at = NOW() + make_interval(
           secs => LEAST(3600, 60 * POWER(2, LEAST(attempt_count, 6))::INTEGER)
         ),
         last_error = LEFT(COALESCE(p_error, 'initialization claim failed'), 2000),
         updated_at = NOW()
   WHERE form_submission_id = p_submission_id
     AND tenant_id = p_tenant_id
     AND state IN ('queued', 'failed');
END;
$$;

CREATE OR REPLACE FUNCTION public.list_form_due_diligence_paid_initialization_work(
  p_limit INTEGER DEFAULT 20
) RETURNS TABLE(form_submission_id UUID, tenant_id UUID)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT lifecycle.form_submission_id, lifecycle.tenant_id
    FROM public.form_due_diligence_initialization lifecycle
    JOIN public.form_submission submission
      ON submission.id = lifecycle.form_submission_id
     AND submission.tenant_id = lifecycle.tenant_id
    JOIN public.form form_row
      ON form_row.id = submission.form_id
     AND form_row.tenant_id = submission.tenant_id
   WHERE lifecycle.paid_eligible
     AND lifecycle.state IN ('queued', 'failed')
     AND lifecycle.next_attempt_at <= NOW()
     -- A marker is prospective eligibility, not a promise to execute after a
     -- later administrator disablement or an anonymity correction. Exclude
     -- these rows before LIMIT so they cannot starve still-eligible work.
     AND COALESCE(form_row.due_diligence_required, FALSE)
     AND NOT COALESCE(submission.is_anonymous, FALSE)
     AND NOT (
       COALESCE(form_row.form_type, '') = 'survey'
       AND COALESCE(form_row.survey_settings->>'response_identity', 'identified') <> 'identified'
     )
     AND (
       submission.payment_status = 'paid'
       OR (
         submission.payment_status = 'setup_complete'
         AND submission.payment_provider IN ('stripe_monthly_card', 'gocardless_monthly_dd')
         AND (
           (submission.payment_provider = 'stripe_monthly_card'
             AND submission.payment_meta->'monthly_card_state'->>'status' = 'done')
           OR
           (submission.payment_provider = 'gocardless_monthly_dd'
             AND submission.payment_meta->'monthly_dd_state'->>'status' = 'done')
         )
       )
     )
   ORDER BY lifecycle.next_attempt_at, lifecycle.created_at, lifecycle.form_submission_id
   LIMIT LEAST(GREATEST(p_limit, 1), 100)
$$;

REVOKE ALL ON TABLE public.form_due_diligence_initialization FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.form_due_diligence_action_checkpoint FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.form_due_diligence_initialization TO service_role;
GRANT ALL ON TABLE public.form_due_diligence_action_checkpoint TO service_role;
REVOKE ALL ON FUNCTION public.claim_form_due_diligence_initialization(UUID, UUID, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkpoint_form_due_diligence_actions(UUID, UUID, UUID, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_form_due_diligence_initialization(UUID, UUID, UUID, BOOLEAN, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_form_due_diligence_claim_failure(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_form_due_diligence_paid_initialization_work(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_form_due_diligence_initialization(UUID, UUID, UUID, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_form_due_diligence_actions(UUID, UUID, UUID, TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_form_due_diligence_initialization(UUID, UUID, UUID, BOOLEAN, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_form_due_diligence_claim_failure(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_form_due_diligence_paid_initialization_work(INTEGER) TO service_role;