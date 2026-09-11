-- Task #4375 follow-up: a paid one-off submission is DD-ready only after its
-- post-payment entity pipeline and (when configured) membership binding have
-- both completed. This is deliberately a separate durable marker so payment
-- finalization metadata is not overwritten by a concurrent financial write.

CREATE TABLE IF NOT EXISTS public.form_due_diligence_one_off_ready (
  form_submission_id UUID PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  ready_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS form_due_diligence_one_off_ready_tenant_idx
  ON public.form_due_diligence_one_off_ready (tenant_id, form_submission_id);

CREATE OR REPLACE FUNCTION public.mark_one_off_form_due_diligence_ready(
  p_tenant_id UUID, p_submission_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_inserted BOOLEAN;
BEGIN
  INSERT INTO public.form_due_diligence_one_off_ready (form_submission_id, tenant_id)
  SELECT submission.id, submission.tenant_id
    FROM public.form_submission submission
   WHERE submission.id = p_submission_id
     AND submission.tenant_id = p_tenant_id
     AND submission.payment_status = 'paid'
     AND submission.payment_provider IS DISTINCT FROM 'stripe_monthly_card'
     AND submission.payment_provider IS DISTINCT FROM 'gocardless_monthly_dd'
  ON CONFLICT (form_submission_id) DO NOTHING
  RETURNING TRUE INTO v_inserted;
  RETURN COALESCE(v_inserted, EXISTS (
    SELECT 1 FROM public.form_due_diligence_one_off_ready ready
     WHERE ready.form_submission_id = p_submission_id AND ready.tenant_id = p_tenant_id
  ));
END;
$$;

-- Keep the original claim implementation as the canonical tenant/form/
-- prospective-marker implementation. The new public wrapper applies the
-- additional readiness gate before that implementation can create a DD row.
ALTER FUNCTION public.claim_form_due_diligence_initialization(UUID, UUID, UUID, BOOLEAN)
  RENAME TO claim_form_due_diligence_initialization_unready;

CREATE OR REPLACE FUNCTION public.claim_form_due_diligence_initialization(
  p_tenant_id UUID, p_submission_id UUID, p_lease_token UUID, p_paid_only BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission public.form_submission%ROWTYPE;
  v_marked BOOLEAN;
BEGIN
  IF NOT p_paid_only THEN
    RETURN public.claim_form_due_diligence_initialization_unready(
      p_tenant_id, p_submission_id, p_lease_token, p_paid_only
    );
  END IF;

  SELECT * INTO v_submission FROM public.form_submission
   WHERE id = p_submission_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN public.claim_form_due_diligence_initialization_unready(
      p_tenant_id, p_submission_id, p_lease_token, p_paid_only
    );
  END IF;

  SELECT lifecycle.paid_eligible INTO v_marked
    FROM public.form_due_diligence_initialization lifecycle
   WHERE lifecycle.form_submission_id = p_submission_id
     AND lifecycle.tenant_id = p_tenant_id;
  IF v_marked IS DISTINCT FROM TRUE THEN
    RETURN public.claim_form_due_diligence_initialization_unready(
      p_tenant_id, p_submission_id, p_lease_token, p_paid_only
    );
  END IF;

  IF v_submission.payment_provider IN ('stripe_monthly_card', 'gocardless_monthly_dd') THEN
    IF v_submission.payment_status <> 'setup_complete'
       OR NOT (
         (v_submission.payment_provider = 'stripe_monthly_card'
           AND v_submission.payment_meta->'monthly_card_state'->>'status' = 'done')
         OR (v_submission.payment_provider = 'gocardless_monthly_dd'
           AND v_submission.payment_meta->'monthly_dd_state'->>'status' = 'done')
       ) THEN
      RETURN jsonb_build_object('claimed', FALSE, 'code', 'PAYMENT_NOT_SUCCESSFUL');
    END IF;
  ELSIF v_submission.payment_status = 'paid' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.form_due_diligence_one_off_ready ready
       WHERE ready.form_submission_id = p_submission_id AND ready.tenant_id = p_tenant_id
    ) THEN
      RETURN jsonb_build_object('claimed', FALSE, 'code', 'ONE_OFF_NOT_READY');
    END IF;
  END IF;

  RETURN public.claim_form_due_diligence_initialization_unready(
    p_tenant_id, p_submission_id, p_lease_token, p_paid_only
  );
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
     AND COALESCE(form_row.due_diligence_required, FALSE)
     AND NOT COALESCE(submission.is_anonymous, FALSE)
     AND NOT (
       COALESCE(form_row.form_type, '') = 'survey'
       AND COALESCE(form_row.survey_settings->>'response_identity', 'identified') <> 'identified'
     )
     AND (
       (
         submission.payment_provider IS DISTINCT FROM 'stripe_monthly_card'
         AND submission.payment_provider IS DISTINCT FROM 'gocardless_monthly_dd'
         AND submission.payment_status = 'paid'
         AND EXISTS (
           SELECT 1 FROM public.form_due_diligence_one_off_ready ready
            WHERE ready.form_submission_id = submission.id AND ready.tenant_id = submission.tenant_id
         )
       )
       OR (
         submission.payment_status = 'setup_complete'
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

REVOKE ALL ON TABLE public.form_due_diligence_one_off_ready FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.form_due_diligence_one_off_ready TO service_role;
REVOKE ALL ON FUNCTION public.claim_form_due_diligence_initialization_unready(UUID, UUID, UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_form_due_diligence_initialization(UUID, UUID, UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_one_off_form_due_diligence_ready(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_form_due_diligence_paid_initialization_work(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_form_due_diligence_initialization(UUID, UUID, UUID, BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_one_off_form_due_diligence_ready(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_form_due_diligence_paid_initialization_work(INTEGER)
  TO service_role;