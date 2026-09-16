-- Task #4446: fair paid-completion scheduling and conservative pipeline
-- operation fencing.  A receipt is the customer-facing source of truth;
-- this table only schedules retryable receipts fairly.
CREATE TABLE IF NOT EXISTS public.form_payment_completion_retry (
  form_submission_id UUID PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS form_payment_completion_retry_due_idx
  ON public.form_payment_completion_retry (next_attempt_at, form_submission_id);

-- Backfill receipts already queued by the browser/reconciler before this
-- scheduler was introduced.  Historical rows without a receipt retain their
-- established legacy finalization path and are intentionally not reopened.
INSERT INTO public.form_payment_completion_retry
  (form_submission_id, tenant_id, next_attempt_at)
SELECT s.id, s.tenant_id, NOW()
  FROM public.form_submission s
 WHERE s.payment_provider = 'stripe'
   AND s.payment_status = 'paid'
   AND s.payment_meta->'completion'->>'version' = '1'
   AND s.payment_meta->'completion'->>'status' NOT IN ('done', 'attention')
ON CONFLICT (form_submission_id) DO NOTHING;

-- One accepted internal processor attempt gets one UUID forever.  In
-- particular, this is not a lease: replaying after a lost response could
-- duplicate record-create workflows before their checkpoint is persisted.
CREATE TABLE IF NOT EXISTS public.form_paid_pipeline_operation (
  form_submission_id UUID PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  operation_kind TEXT NOT NULL DEFAULT 'primary'
    CHECK (operation_kind IN ('primary', 'followup')),
  status TEXT NOT NULL CHECK (status IN ('processing', 'done', 'attention')),
  last_error TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.form_paid_pipeline_operation
  ADD COLUMN IF NOT EXISTS operation_kind TEXT NOT NULL DEFAULT 'primary'
    CHECK (operation_kind IN ('primary', 'followup'));
CREATE INDEX IF NOT EXISTS form_paid_pipeline_operation_attention_idx
  ON public.form_paid_pipeline_operation (status, updated_at);

CREATE OR REPLACE FUNCTION public.queue_form_payment_completion(
  p_tenant_id UUID,
  p_submission_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_meta JSONB;
BEGIN
  UPDATE public.form_submission s
     SET payment_meta = CASE
       WHEN COALESCE(s.payment_meta, '{}'::JSONB)->'completion'->>'version' = '1'
         THEN s.payment_meta
       ELSE jsonb_set(COALESCE(s.payment_meta, '{}'::JSONB), '{completion}',
         jsonb_build_object('version', 1, 'status', 'queued',
           'queued_at', NOW()::TEXT, 'attempts', 0), true)
     END
   WHERE s.id = p_submission_id
     AND s.tenant_id = p_tenant_id
     AND s.payment_provider = 'stripe'
     AND s.payment_status IN ('pending', 'paid')
   RETURNING payment_meta INTO v_meta;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stripe payment completion submission was not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.form_payment_completion_retry
    (form_submission_id, tenant_id, next_attempt_at)
  VALUES (p_submission_id, p_tenant_id, NOW())
  ON CONFLICT (form_submission_id) DO UPDATE
    SET next_attempt_at = LEAST(form_payment_completion_retry.next_attempt_at, EXCLUDED.next_attempt_at),
        updated_at = NOW();
  RETURN v_meta;
END;
$$;

-- Each claim advances its due time before returning a row.  This prevents an
-- old failure from monopolising a bounded sweep even if its worker dies before
-- writing a receipt outcome.
CREATE OR REPLACE FUNCTION public.claim_form_payment_completion_retries(
  p_limit INTEGER DEFAULT 20
) RETURNS SETOF public.form_submission
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT r.form_submission_id
      FROM public.form_payment_completion_retry r
      JOIN public.form_submission s ON s.id = r.form_submission_id
     WHERE r.next_attempt_at <= NOW()
       AND s.payment_status = 'paid'
       AND s.payment_provider = 'stripe'
       AND COALESCE(s.payment_meta->'completion'->>'status', 'queued')
           NOT IN ('done', 'attention')
     ORDER BY r.next_attempt_at ASC, r.form_submission_id ASC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))
     FOR UPDATE OF r SKIP LOCKED
  ), bumped AS (
    UPDATE public.form_payment_completion_retry r
       SET attempt_count = r.attempt_count + 1,
           -- A receipt outcome normally replaces this with exponential
           -- backoff.  This fallback protects fairness on worker death.
           next_attempt_at = NOW() + INTERVAL '2 minutes',
           updated_at = NOW()
      FROM due WHERE r.form_submission_id = due.form_submission_id
    RETURNING r.form_submission_id
  )
  SELECT s.* FROM public.form_submission s
   JOIN bumped b ON b.form_submission_id = s.id
   ORDER BY s.payment_paid_at NULLS LAST, s.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_form_payment_completion_retry(
  p_tenant_id UUID, p_submission_id UUID, p_status TEXT, p_error TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_attempts INTEGER;
BEGIN
  IF p_status NOT IN ('retryable', 'done', 'attention') THEN
    RAISE EXCEPTION 'invalid completion retry status' USING ERRCODE = '22023';
  END IF;
  IF p_status IN ('done', 'attention') THEN
    DELETE FROM public.form_payment_completion_retry
     WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id;
    RETURN FOUND;
  END IF;
  SELECT attempt_count INTO v_attempts FROM public.form_payment_completion_retry
   WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.form_payment_completion_retry
     SET next_attempt_at = NOW() + make_interval(secs => LEAST(3600, 15 * (2 ^ LEAST(v_attempts, 8))::INTEGER)),
         last_error = LEFT(COALESCE(p_error, 'retry incomplete'), 300),
         updated_at = NOW()
   WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id;
  RETURN true;
END;
$$;

DROP FUNCTION IF EXISTS public.begin_form_paid_pipeline_operation(UUID, UUID, UUID);

CREATE OR REPLACE FUNCTION public.begin_form_paid_pipeline_operation(
  p_tenant_id UUID, p_submission_id UUID, p_operation_id UUID,
  p_operation_kind TEXT DEFAULT 'primary'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row public.form_paid_pipeline_operation%ROWTYPE;
BEGIN
  IF p_operation_kind NOT IN ('primary', 'followup') THEN
    RAISE EXCEPTION 'invalid paid pipeline operation kind' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.form_paid_pipeline_operation
   WHERE form_submission_id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.form_paid_pipeline_operation
       (form_submission_id, tenant_id, operation_id, operation_kind, status)
     VALUES (p_submission_id, p_tenant_id, p_operation_id, p_operation_kind, 'processing');
    RETURN jsonb_build_object('status', 'claimed');
  END IF;
  IF v_row.tenant_id <> p_tenant_id THEN
    RAISE EXCEPTION 'pipeline operation tenant mismatch' USING ERRCODE = '42501';
  END IF;
  -- The ordinary completion retry must reuse the known durable response, even
  -- when its new receipt owner has a different UUID. Only a narrowly-scoped
  -- follow-up whose persisted pending marker proves more work is needed can
  -- supersede a completed operation.
  IF v_row.status = 'done' THEN
    IF v_row.operation_id = p_operation_id OR p_operation_kind <> 'followup' THEN
      RETURN jsonb_build_object('status', 'done');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.form_submission s
       WHERE s.id = p_submission_id AND s.tenant_id = p_tenant_id
         AND (
           COALESCE((s.payment_meta->>'structured_actions_pending')::BOOLEAN, FALSE)
           OR COALESCE((s.payment_meta->>'related_records_pending')::BOOLEAN, FALSE)
         )
    ) THEN
      RETURN jsonb_build_object('status', 'done');
    END IF;
    UPDATE public.form_paid_pipeline_operation
       SET operation_id = p_operation_id, operation_kind = p_operation_kind,
           status = 'processing',
           last_error = NULL, updated_at = NOW(), finished_at = NULL
     WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id;
    RETURN jsonb_build_object('status', 'claimed');
  END IF;
  IF v_row.operation_id = p_operation_id AND v_row.status = 'processing' THEN
    RETURN jsonb_build_object('status', 'claimed');
  END IF;
  -- Serverless termination means we cannot know whether side effects occurred.
  -- Make the ambiguity visible rather than expiring/replaying this operation.
  IF v_row.status = 'processing' AND v_row.updated_at < NOW() - INTERVAL '10 minutes' THEN
    UPDATE public.form_paid_pipeline_operation
       SET status = 'attention', last_error = 'processor owner disappeared before a durable outcome',
           updated_at = NOW(), finished_at = NOW()
     WHERE form_submission_id = p_submission_id;
    RETURN jsonb_build_object('status', 'attention',
      'reason', 'processor outcome is ambiguous and requires administrator review');
  END IF;
  RETURN jsonb_build_object('status', v_row.status,
    'reason', 'processor operation is already owned or requires administrator review');
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_form_paid_pipeline_operation(
  p_tenant_id UUID, p_submission_id UUID, p_operation_id UUID,
  p_status TEXT, p_error TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_status NOT IN ('done', 'attention') THEN
    RAISE EXCEPTION 'invalid paid pipeline operation status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.form_paid_pipeline_operation
     SET status = p_status,
         last_error = CASE WHEN p_status = 'attention' THEN LEFT(COALESCE(p_error, 'processor outcome unavailable'), 300) ELSE NULL END,
         updated_at = NOW(), finished_at = NOW()
   WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id
     AND operation_id = p_operation_id
     AND (status = 'processing' OR (status = 'attention' AND p_status = 'done'));
  RETURN FOUND;
END;
$$;

-- Do not turn an abandoned email send back into a sendable state.  A timeout
-- can occur after Mailgun accepted the message, and the API has no suitable
-- idempotency/status contract for an automatic replay.
CREATE OR REPLACE FUNCTION public.mark_stale_submission_email_attention(
  p_submission_id UUID, p_claim_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_state JSONB;
BEGIN
  UPDATE public.form_submission s
     SET submission_email_state = (s.submission_email_state || jsonb_build_object(
       'status', 'attention',
       'attention_at', NOW()::TEXT,
       'reason', 'email delivery response was unavailable; do not automatically resend'))
   WHERE s.id = p_submission_id
     AND s.submission_email_state->>'status' = 'processing'
     AND s.submission_email_state->>'claim_id' = p_claim_id::TEXT
     AND COALESCE((s.submission_email_state->>'claimed_at')::TIMESTAMPTZ, NOW())
         < NOW() - INTERVAL '10 minutes'
  RETURNING submission_email_state INTO v_state;
  IF FOUND THEN RETURN v_state; END IF;
  SELECT submission_email_state INTO v_state
    FROM public.form_submission WHERE id = p_submission_id;
  RETURN v_state;
END;
$$;

-- Existing receipt ownership is still fenced by the finalizer owner token.
CREATE OR REPLACE FUNCTION public.finish_form_payment_completion(
  p_tenant_id UUID, p_submission_id UUID, p_owner_token UUID, p_status TEXT,
  p_stage TEXT DEFAULT NULL, p_error TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_updated UUID;
BEGIN
  IF p_status NOT IN ('retryable', 'done', 'attention') THEN
    RAISE EXCEPTION 'invalid form completion status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.form_submission s SET payment_meta = jsonb_set(
    COALESCE(s.payment_meta, '{}'::JSONB), '{completion}',
    (s.payment_meta->'completion') || jsonb_strip_nulls(jsonb_build_object(
      'status', p_status, 'stage', p_stage,
      'last_error', CASE WHEN p_status = 'done' THEN NULL ELSE LEFT(COALESCE(p_error, 'retry incomplete'), 300) END,
      'completed_at', CASE WHEN p_status = 'done' THEN NOW()::TEXT ELSE NULL END,
      'attention_at', CASE WHEN p_status = 'attention' THEN NOW()::TEXT ELSE NULL END)), true)
   WHERE s.id = p_submission_id AND s.tenant_id = p_tenant_id AND s.payment_status = 'paid'
     AND s.payment_meta->'completion'->>'status' = 'processing'
     AND s.payment_meta->'completion'->>'owner_token' = p_owner_token::TEXT
  RETURNING s.id INTO v_updated;
  RETURN v_updated IS NOT NULL;
END;
$$;

-- Address retry ownership is fenced as well.  A stale worker may still
-- complete a Stripe read/mapping after a later worker claimed the row; it
-- cannot delete or re-schedule that newer owner's retry record.
ALTER TABLE public.form_stripe_address_mapping_retry
  ADD COLUMN IF NOT EXISTS owner_token UUID NULL;

-- The claim response now includes a lease owner; PostgreSQL does not permit
-- CREATE OR REPLACE to change a function's OUT-column shape.
DROP FUNCTION IF EXISTS public.claim_form_stripe_address_mapping_retries(INTEGER);

CREATE OR REPLACE FUNCTION public.claim_form_stripe_address_mapping_retries(
  p_limit INTEGER DEFAULT 20
) RETURNS TABLE(submission JSONB, lease_token UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'retry claim limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.form_stripe_address_mapping_retry (form_submission_id, tenant_id)
  SELECT s.id, s.tenant_id FROM public.form_submission s
   WHERE s.payment_provider = 'stripe' AND s.payment_status = 'paid'
     AND (s.payment_meta ? 'membership'
       OR (jsonb_typeof(s.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
         AND jsonb_array_length(s.payment_meta->'stripe_address_mapping_config'->'mappings') > 0))
     AND s.payment_meta->'stripe_billing_address' IS NULL
     AND COALESCE(s.payment_meta->'completion'->>'status', '') <> 'attention'
  ON CONFLICT (form_submission_id) DO NOTHING;
  RETURN QUERY
  WITH due AS (
    SELECT r.form_submission_id FROM public.form_stripe_address_mapping_retry r
    JOIN public.form_submission s ON s.id = r.form_submission_id AND s.tenant_id = r.tenant_id
    WHERE r.next_attempt_at <= NOW()
      AND (r.claimed_at IS NULL OR r.claimed_at < NOW() - INTERVAL '5 minutes')
      AND s.payment_provider = 'stripe' AND s.payment_status = 'paid'
      AND s.payment_meta->'stripe_billing_address' IS NULL
      AND COALESCE(s.payment_meta->'completion'->>'status', '') <> 'attention'
    ORDER BY r.next_attempt_at, r.created_at, r.form_submission_id
    FOR UPDATE OF r SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE public.form_stripe_address_mapping_retry r
       SET claimed_at = NOW(), owner_token = gen_random_uuid(),
           attempt_count = r.attempt_count + 1,
           next_attempt_at = NOW() + make_interval(
             secs => LEAST(3600, 60 * POWER(2, LEAST(r.attempt_count, 6))::INTEGER))
      FROM due WHERE r.form_submission_id = due.form_submission_id
    RETURNING r.form_submission_id, r.owner_token
  )
  SELECT to_jsonb(s), c.owner_token
    FROM claimed c JOIN public.form_submission s ON s.id = c.form_submission_id;
END;
$$;

DROP FUNCTION IF EXISTS public.finish_form_stripe_address_mapping_retry(UUID, UUID, BOOLEAN, TEXT);

CREATE OR REPLACE FUNCTION public.finish_form_stripe_address_mapping_retry(
  p_tenant_id UUID, p_submission_id UUID, p_owner_token UUID,
  p_succeeded BOOLEAN, p_error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_succeeded THEN
    DELETE FROM public.form_stripe_address_mapping_retry r
     WHERE r.form_submission_id = p_submission_id AND r.tenant_id = p_tenant_id
       AND r.owner_token = p_owner_token
       AND EXISTS (SELECT 1 FROM public.form_submission s
                     WHERE s.id = r.form_submission_id AND s.tenant_id = r.tenant_id
                       AND s.payment_meta->'stripe_billing_address' IS NOT NULL);
  ELSE
    UPDATE public.form_stripe_address_mapping_retry
       SET claimed_at = NULL, owner_token = NULL,
           last_error = LEFT(COALESCE(p_error, 'retry incomplete'), 2000)
     WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id
       AND owner_token = p_owner_token;
  END IF;
END;
$$;

-- A completion attention state gates the alternate DD-readiness sweep too.
-- Otherwise that sweep could invoke the paid finalizer after the primary
-- completion worker correctly stopped automatic replay.
CREATE OR REPLACE FUNCTION public.claim_missing_one_off_form_due_diligence_ready(
  p_limit INTEGER DEFAULT 20
) RETURNS TABLE(form_submission_id UUID, tenant_id UUID, lease_token UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT lifecycle.form_submission_id, lifecycle.tenant_id
      FROM public.form_due_diligence_initialization lifecycle
      JOIN public.form_submission s ON s.id = lifecycle.form_submission_id AND s.tenant_id = lifecycle.tenant_id
      LEFT JOIN public.form_due_diligence_one_off_ready ready
        ON ready.form_submission_id = s.id AND ready.tenant_id = s.tenant_id
      LEFT JOIN public.form_due_diligence_one_off_ready_recovery recovery
        ON recovery.form_submission_id = s.id AND recovery.tenant_id = s.tenant_id
     WHERE lifecycle.paid_eligible AND s.payment_status = 'paid'
       AND s.payment_provider IS DISTINCT FROM 'stripe_monthly_card'
       AND s.payment_provider IS DISTINCT FROM 'gocardless_monthly_dd'
       AND COALESCE(s.payment_meta->>'finalized', 'false') = 'true'
       AND COALESCE(s.payment_meta->'completion'->>'status', '') <> 'attention'
       AND COALESCE(NULLIF(s.payment_meta->>'finalized_at', '')::TIMESTAMPTZ, lifecycle.updated_at)
             <= NOW() - INTERVAL '10 minutes'
       AND ready.form_submission_id IS NULL
       AND (recovery.form_submission_id IS NULL
         OR (recovery.state = 'failed' AND recovery.next_attempt_at <= NOW()))
     ORDER BY lifecycle.created_at, lifecycle.form_submission_id
     LIMIT LEAST(GREATEST(p_limit, 1), 100)
     FOR UPDATE OF lifecycle SKIP LOCKED
  ), claimed AS (
    INSERT INTO public.form_due_diligence_one_off_ready_recovery
      (form_submission_id, tenant_id, state, lease_token, lease_expires_at, updated_at)
    SELECT c.form_submission_id, c.tenant_id, 'processing', gen_random_uuid(), NOW() + INTERVAL '10 minutes', NOW()
      FROM candidates c
    ON CONFLICT ON CONSTRAINT form_due_diligence_one_off_ready_recovery_pkey DO UPDATE
      SET state = 'processing', lease_token = gen_random_uuid(),
          lease_expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW(), last_error = NULL
      WHERE public.form_due_diligence_one_off_ready_recovery.state = 'failed'
        AND public.form_due_diligence_one_off_ready_recovery.next_attempt_at <= NOW()
    RETURNING form_submission_id, tenant_id, lease_token
  )
  SELECT form_submission_id, tenant_id, lease_token FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_form_due_diligence_paid_initialization_work(
  p_limit INTEGER DEFAULT 20
) RETURNS TABLE(form_submission_id UUID, tenant_id UUID)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT lifecycle.form_submission_id, lifecycle.tenant_id
    FROM public.form_due_diligence_initialization lifecycle
    JOIN public.form_submission s ON s.id = lifecycle.form_submission_id AND s.tenant_id = lifecycle.tenant_id
    JOIN public.form f ON f.id = s.form_id AND f.tenant_id = s.tenant_id
   WHERE lifecycle.paid_eligible AND lifecycle.state IN ('queued', 'failed')
     AND lifecycle.next_attempt_at <= NOW()
     AND COALESCE(f.due_diligence_required, FALSE) AND NOT COALESCE(s.is_anonymous, FALSE)
     AND NOT (COALESCE(f.form_type, '') = 'survey'
       AND COALESCE(f.survey_settings->>'response_identity', 'identified') <> 'identified')
     AND COALESCE(s.payment_meta->'completion'->>'status', '') <> 'attention'
     AND (
       (s.payment_provider IS DISTINCT FROM 'stripe_monthly_card'
        AND s.payment_provider IS DISTINCT FROM 'gocardless_monthly_dd'
        AND s.payment_status = 'paid'
        AND EXISTS (SELECT 1 FROM public.form_due_diligence_one_off_ready ready
                      WHERE ready.form_submission_id = s.id AND ready.tenant_id = s.tenant_id))
       OR (s.payment_status = 'setup_complete' AND (
         (s.payment_provider = 'stripe_monthly_card' AND s.payment_meta->'monthly_card_state'->>'status' = 'done')
         OR (s.payment_provider = 'gocardless_monthly_dd' AND s.payment_meta->'monthly_dd_state'->>'status' = 'done'))))
   ORDER BY lifecycle.next_attempt_at, lifecycle.created_at, lifecycle.form_submission_id
   LIMIT LEAST(GREATEST(p_limit, 1), 100)
$$;

-- SECURITY DEFINER functions below expose payment/completion rows or mutate
-- financial state.  They are service-worker seams, never browser RPCs.
REVOKE ALL ON TABLE public.form_payment_completion_retry, public.form_paid_pipeline_operation
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.form_payment_completion_retry, public.form_paid_pipeline_operation TO service_role;
REVOKE ALL ON FUNCTION public.queue_form_payment_completion(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_form_payment_completion_retries(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_form_payment_completion_retry(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_form_paid_pipeline_operation(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_form_paid_pipeline_operation(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_stale_submission_email_attention(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_form_payment_completion(UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capture_form_stripe_billing_address_once(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_form_stripe_address_mapping_retries(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_form_stripe_address_mapping_retry(UUID, UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_missing_one_off_form_due_diligence_ready(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_form_due_diligence_paid_initialization_work(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_form_payment_completion(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_form_payment_completion_retries(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_form_payment_completion_retry(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_form_paid_pipeline_operation(UUID, UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_form_paid_pipeline_operation(UUID, UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_stale_submission_email_attention(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_form_payment_completion(UUID, UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.capture_form_stripe_billing_address_once(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_form_stripe_address_mapping_retries(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_form_stripe_address_mapping_retry(UUID, UUID, UUID, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_missing_one_off_form_due_diligence_ready(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_form_due_diligence_paid_initialization_work(INTEGER) TO service_role;