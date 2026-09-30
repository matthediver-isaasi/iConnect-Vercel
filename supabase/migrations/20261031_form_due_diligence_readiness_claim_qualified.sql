-- Fix the readiness claim's SQLSTATE 42702 regression without changing its
-- eligibility, lease, or retry policy. RETURNS TABLE names are also PL/pgSQL
-- variables, so RETURNING and the final SELECT must qualify their columns.
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
    INSERT INTO public.form_due_diligence_one_off_ready_recovery AS recovery_claim
      (form_submission_id, tenant_id, state, lease_token, lease_expires_at, updated_at)
    SELECT c.form_submission_id, c.tenant_id, 'processing', gen_random_uuid(), NOW() + INTERVAL '10 minutes', NOW()
      FROM candidates c
    ON CONFLICT ON CONSTRAINT form_due_diligence_one_off_ready_recovery_pkey DO UPDATE
      SET state = 'processing', lease_token = gen_random_uuid(),
          lease_expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW(), last_error = NULL
      WHERE recovery_claim.state = 'failed'
        AND recovery_claim.next_attempt_at <= NOW()
    RETURNING recovery_claim.form_submission_id, recovery_claim.tenant_id, recovery_claim.lease_token
  )
  SELECT claimed.form_submission_id, claimed.tenant_id, claimed.lease_token FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_missing_one_off_form_due_diligence_ready(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_missing_one_off_form_due_diligence_ready(INTEGER)
  TO service_role;