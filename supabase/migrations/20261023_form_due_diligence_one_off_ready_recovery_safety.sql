-- Task #4375 follow-up: never race the worker that just wrote the one-off
-- finalized stamp, and never reclaim an interrupted readiness prerequisite.

ALTER TABLE public.form_due_diligence_one_off_ready_recovery
  ALTER COLUMN lease_expires_at DROP NOT NULL;

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
       -- finalized_at is written by the finalizer. Legacy finalized rows use
       -- lifecycle.updated_at, retaining a conservative ten-minute quiet
       -- period before a cron can resume their prerequisites.
       AND COALESCE(
         NULLIF(submission.payment_meta->>'finalized_at', '')::TIMESTAMPTZ,
         lifecycle.updated_at
       ) <= NOW() - INTERVAL '10 minutes'
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

CREATE OR REPLACE FUNCTION public.mark_expired_missing_one_off_form_due_diligence_ready_attention(
  p_limit INTEGER DEFAULT 20
) RETURNS TABLE(form_submission_id UUID, tenant_id UUID, last_error TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH expired AS (
    SELECT recovery.form_submission_id, recovery.tenant_id
      FROM public.form_due_diligence_one_off_ready_recovery recovery
     WHERE recovery.state = 'processing'
       AND recovery.lease_expires_at <= NOW()
     ORDER BY recovery.lease_expires_at, recovery.form_submission_id
     LIMIT LEAST(GREATEST(p_limit, 1), 100)
     FOR UPDATE SKIP LOCKED
  ), transitioned AS (
    UPDATE public.form_due_diligence_one_off_ready_recovery recovery
       SET state = 'requires_attention',
           lease_expires_at = NULL,
           last_error = LEFT(CONCAT_WS('; ', NULLIF(recovery.last_error, ''),
             'Readiness recovery lease expired; prerequisite completion is ambiguous and requires manual review'), 2000),
           updated_at = NOW()
      FROM expired
     WHERE recovery.form_submission_id = expired.form_submission_id
       AND recovery.tenant_id = expired.tenant_id
     RETURNING recovery.form_submission_id, recovery.tenant_id, recovery.last_error
  )
  SELECT transitioned.form_submission_id, transitioned.tenant_id, transitioned.last_error FROM transitioned;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_missing_one_off_form_due_diligence_ready(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_expired_missing_one_off_form_due_diligence_ready_attention(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_missing_one_off_form_due_diligence_ready(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_expired_missing_one_off_form_due_diligence_ready_attention(INTEGER) TO service_role;