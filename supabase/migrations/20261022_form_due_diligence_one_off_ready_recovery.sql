-- Recover prospective one-off submissions which crashed after the financial
-- finalized stamp but before the DD-ready marker. This lease is independent
-- of the DD action lifecycle: it protects only rerunning idempotent
-- finalization prerequisites, never an external DD action.
CREATE TABLE IF NOT EXISTS public.form_due_diligence_one_off_ready_recovery (
  form_submission_id UUID PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'processing' CHECK (state IN ('processing', 'failed', 'completed', 'requires_attention')),
  lease_token UUID NOT NULL DEFAULT gen_random_uuid(),
  lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS form_dd_one_off_ready_recovery_work_idx
  ON public.form_due_diligence_one_off_ready_recovery (next_attempt_at, form_submission_id)
  WHERE state = 'failed';

CREATE OR REPLACE FUNCTION public.claim_missing_one_off_form_due_diligence_ready(
  p_limit INTEGER DEFAULT 20
) RETURNS TABLE(form_submission_id UUID, tenant_id UUID, lease_token UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT lifecycle.form_submission_id, lifecycle.tenant_id
      FROM public.form_due_diligence_initialization lifecycle
      JOIN public.form_submission submission
        ON submission.id = lifecycle.form_submission_id AND submission.tenant_id = lifecycle.tenant_id
      LEFT JOIN public.form_due_diligence_one_off_ready ready
        ON ready.form_submission_id = submission.id AND ready.tenant_id = submission.tenant_id
      LEFT JOIN public.form_due_diligence_one_off_ready_recovery recovery
        ON recovery.form_submission_id = submission.id AND recovery.tenant_id = submission.tenant_id
     WHERE lifecycle.paid_eligible
       AND submission.payment_status = 'paid'
       AND submission.payment_provider IS DISTINCT FROM 'stripe_monthly_card'
       AND submission.payment_provider IS DISTINCT FROM 'gocardless_monthly_dd'
       AND COALESCE(submission.payment_meta->>'finalized', 'false') = 'true'
       AND ready.form_submission_id IS NULL
       AND (recovery.form_submission_id IS NULL
         OR (recovery.state = 'failed' AND recovery.next_attempt_at <= NOW()))
     ORDER BY lifecycle.created_at, lifecycle.form_submission_id
     LIMIT LEAST(GREATEST(p_limit, 1), 100)
     FOR UPDATE OF lifecycle SKIP LOCKED
  ), claimed AS (
    INSERT INTO public.form_due_diligence_one_off_ready_recovery
      (form_submission_id, tenant_id, state, lease_token, lease_expires_at, updated_at)
    SELECT candidates.form_submission_id, candidates.tenant_id, 'processing', gen_random_uuid(), NOW() + INTERVAL '10 minutes', NOW()
      FROM candidates
    ON CONFLICT ON CONSTRAINT form_due_diligence_one_off_ready_recovery_pkey DO UPDATE
      SET state = 'processing', lease_token = gen_random_uuid(),
          lease_expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW(), last_error = NULL
      WHERE public.form_due_diligence_one_off_ready_recovery.state = 'failed'
        AND public.form_due_diligence_one_off_ready_recovery.next_attempt_at <= NOW()
    RETURNING public.form_due_diligence_one_off_ready_recovery.form_submission_id,
      public.form_due_diligence_one_off_ready_recovery.tenant_id,
      public.form_due_diligence_one_off_ready_recovery.lease_token
  )
  SELECT claimed.form_submission_id, claimed.tenant_id, claimed.lease_token FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_missing_one_off_form_due_diligence_ready(
  p_tenant_id UUID, p_submission_id UUID, p_lease_token UUID, p_succeeded BOOLEAN, p_error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.form_due_diligence_one_off_ready_recovery
     SET state = CASE WHEN p_succeeded THEN 'completed' ELSE 'failed' END,
         lease_expires_at = NULL,
         attempt_count = CASE WHEN p_succeeded THEN attempt_count ELSE attempt_count + 1 END,
         next_attempt_at = CASE WHEN p_succeeded THEN NOW()
           ELSE NOW() + make_interval(secs => LEAST(3600, 60 * POWER(2, LEAST(attempt_count, 6))::INTEGER)) END,
         last_error = CASE WHEN p_succeeded THEN NULL ELSE LEFT(COALESCE(p_error, 'finalization prerequisites incomplete'), 2000) END,
         updated_at = NOW()
   WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id
     AND state = 'processing' AND lease_token = p_lease_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'one-off readiness recovery lease is not held' USING ERRCODE = 'P0001'; END IF;
END;
$$;

REVOKE ALL ON TABLE public.form_due_diligence_one_off_ready_recovery FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.form_due_diligence_one_off_ready_recovery TO service_role;
REVOKE ALL ON FUNCTION public.claim_missing_one_off_form_due_diligence_ready(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_missing_one_off_form_due_diligence_ready(UUID, UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_missing_one_off_form_due_diligence_ready(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_missing_one_off_form_due_diligence_ready(UUID, UUID, UUID, BOOLEAN, TEXT) TO service_role;