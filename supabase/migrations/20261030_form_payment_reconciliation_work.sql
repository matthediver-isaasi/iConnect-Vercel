-- Additive Task #4446 follow-up: give the worker one fair stream over the
-- existing completion and Stripe-address retry queues.  The existing claim
-- functions remain unchanged for older workers/deployments.
--
-- This function deliberately does not create a completion receipt or alter
-- payment_meta.  Only rows already carrying the versioned completion receipt
-- can enter the completion queue.
CREATE OR REPLACE FUNCTION public.claim_form_payment_reconciliation_work()
RETURNS TABLE(work_kind TEXT, submission JSONB, lease_token UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Registration is limited to obligations that the existing workers already
  -- recognise.  In particular, this does not manufacture legacy receipts or
  -- reopen historical/past due-diligence submissions.
  INSERT INTO public.form_payment_completion_retry
    (form_submission_id, tenant_id, next_attempt_at)
  SELECT s.id, s.tenant_id, NOW()
    FROM public.form_submission s
   WHERE s.payment_provider = 'stripe'
     AND s.payment_status = 'paid'
     AND s.payment_meta->'completion'->>'version' = '1'
     AND COALESCE(s.payment_meta->'completion'->>'status', 'queued')
           NOT IN ('done', 'attention')
     AND NOT EXISTS (
       SELECT 1
         FROM public.form_payment_completion_retry existing_retry
        WHERE existing_retry.form_submission_id = s.id
     )
  ON CONFLICT (form_submission_id) DO NOTHING;

  INSERT INTO public.form_stripe_address_mapping_retry
    (form_submission_id, tenant_id)
  SELECT s.id, s.tenant_id
    FROM public.form_submission s
   WHERE (
       (s.payment_provider = 'stripe' AND s.payment_status = 'paid')
       OR
       (s.payment_provider = 'stripe_monthly_card'
        AND s.payment_status = 'setup_complete')
     )
     AND (
       s.payment_meta ? 'membership'
       OR (
         jsonb_typeof(s.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
         AND jsonb_array_length(s.payment_meta->'stripe_address_mapping_config'->'mappings') > 0
       )
     )
     AND (
      jsonb_typeof(s.payment_meta->'stripe_billing_address') IS DISTINCT FROM 'object'
       OR (
         jsonb_typeof(s.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
         AND jsonb_array_length(s.payment_meta->'stripe_address_mapping_config'->'mappings') > 0
         AND NOT EXISTS (
           SELECT 1
             FROM public.form_stripe_address_mapping_ledger ledger
            WHERE ledger.form_submission_id = s.id
              AND ledger.tenant_id = s.tenant_id
         )
       )
     )
     AND COALESCE(s.payment_meta->'completion'->>'status', '') <> 'attention'
    AND NOT EXISTS (
      SELECT 1
        FROM public.form_stripe_address_mapping_retry existing_retry
       WHERE existing_retry.form_submission_id = s.id
    )
  ON CONFLICT (form_submission_id) DO NOTHING;

  -- Each queue contributes only its oldest currently claimable row.  The two
  -- queue rows are locked with SKIP LOCKED before the global ordering is
  -- applied; only the selected row is bumped.  This avoids a fixed
  -- service-class priority while keeping concurrent calls non-blocking.
  RETURN QUERY
  WITH completion_due AS MATERIALIZED (
    SELECT
      'completion'::TEXT AS work_kind,
      r.form_submission_id,
      r.tenant_id,
      r.next_attempt_at,
      r.created_at
    FROM public.form_payment_completion_retry r
    JOIN public.form_submission s
      ON s.id = r.form_submission_id
     AND s.tenant_id = r.tenant_id
   WHERE r.next_attempt_at <= NOW()
     AND s.payment_provider = 'stripe'
     AND s.payment_status = 'paid'
     AND s.payment_meta->'completion'->>'version' = '1'
    AND COALESCE(s.payment_meta->'completion'->>'status', 'queued')
          NOT IN ('done', 'attention')
    AND (
      COALESCE(s.payment_meta->'completion'->>'status', 'queued') <> 'processing'
      OR NULLIF(s.payment_meta->'completion'->>'claimed_at', '') IS NULL
      OR NULLIF(s.payment_meta->'completion'->>'claimed_at', '')::TIMESTAMPTZ
           <= NOW() - INTERVAL '2 minutes'
    )
     AND (
      jsonb_typeof(s.payment_meta->'stripe_billing_address') = 'object'
       OR NOT (
         s.payment_meta ? 'membership'
         OR COALESCE((
           jsonb_typeof(s.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
           AND jsonb_array_length(s.payment_meta->'stripe_address_mapping_config'->'mappings') > 0
         ), FALSE)
       )
     )
   ORDER BY r.next_attempt_at, r.created_at, r.form_submission_id
   FOR UPDATE OF r SKIP LOCKED
   LIMIT 1
  ),
  address_due AS MATERIALIZED (
    SELECT
      'address'::TEXT AS work_kind,
      r.form_submission_id,
      r.tenant_id,
      r.next_attempt_at,
      r.created_at
    FROM public.form_stripe_address_mapping_retry r
    JOIN public.form_submission s
      ON s.id = r.form_submission_id
     AND s.tenant_id = r.tenant_id
   WHERE r.next_attempt_at <= NOW()
     AND (r.claimed_at IS NULL OR r.claimed_at < NOW() - INTERVAL '5 minutes')
     AND (
       (s.payment_provider = 'stripe' AND s.payment_status = 'paid')
       OR
       (s.payment_provider = 'stripe_monthly_card'
        AND s.payment_status = 'setup_complete')
     )
     AND (
      jsonb_typeof(s.payment_meta->'stripe_billing_address') IS DISTINCT FROM 'object'
       OR (
         jsonb_typeof(s.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
         AND jsonb_array_length(s.payment_meta->'stripe_address_mapping_config'->'mappings') > 0
         AND NOT EXISTS (
           SELECT 1
             FROM public.form_stripe_address_mapping_ledger ledger
            WHERE ledger.form_submission_id = s.id
              AND ledger.tenant_id = s.tenant_id
         )
       )
     )
     -- Attention is a terminal administrative decision.  It must not be
     -- bypassed by the alternate address worker.
     AND COALESCE(s.payment_meta->'completion'->>'status', '') <> 'attention'
     -- Once a v1 completion owns a payment-time snapshot, it owns the
     -- completion/mapping follow-up until it reaches done.  Without the
     -- snapshot, address work is still eligible and is the prerequisite for
     -- completion.  This also prevents a missing target checkpoint from
     -- repeatedly stealing completion work.
     AND NOT (
      COALESCE(s.payment_meta->'completion'->>'version', '') = '1'
      AND COALESCE(
        jsonb_typeof(s.payment_meta->'stripe_billing_address') = 'object',
        FALSE
      )
       AND COALESCE(s.payment_meta->'completion'->>'status', '')
             NOT IN ('done', 'attention')
     )
   ORDER BY r.next_attempt_at, r.created_at, r.form_submission_id
   FOR UPDATE OF r SKIP LOCKED
   LIMIT 1
  ),
  candidates AS (
    SELECT * FROM completion_due
    UNION ALL
    SELECT * FROM address_due
  ),
  chosen AS MATERIALIZED (
    SELECT *
      FROM candidates c
     ORDER BY c.next_attempt_at, c.created_at, c.form_submission_id, c.work_kind
     LIMIT 1
  ),
  bumped_completion AS (
    UPDATE public.form_payment_completion_retry r
       SET attempt_count = r.attempt_count + 1,
           -- The finalizer owns a separate lease.  This bump only protects
           -- the queue if the worker disappears before finalizer work starts.
           next_attempt_at = NOW() + INTERVAL '2 minutes',
           updated_at = NOW()
      FROM chosen c
     WHERE c.work_kind = 'completion'
       AND r.form_submission_id = c.form_submission_id
       AND r.tenant_id = c.tenant_id
    RETURNING r.form_submission_id, r.tenant_id
  ),
  bumped_address AS (
    UPDATE public.form_stripe_address_mapping_retry r
       SET claimed_at = NOW(),
           owner_token = gen_random_uuid(),
           attempt_count = r.attempt_count + 1,
           next_attempt_at = NOW() + make_interval(
             secs => LEAST(
               3600,
               60 * POWER(2, LEAST(r.attempt_count, 6))::INTEGER
             )
           )
      FROM chosen c
     WHERE c.work_kind = 'address'
       AND r.form_submission_id = c.form_submission_id
       AND r.tenant_id = c.tenant_id
    RETURNING r.form_submission_id, r.tenant_id, r.owner_token
  ),
  bumped AS (
    SELECT 'completion'::TEXT AS work_kind,
           form_submission_id,
           tenant_id,
           NULL::UUID AS lease_token
      FROM bumped_completion
    UNION ALL
    SELECT 'address'::TEXT AS work_kind,
           form_submission_id,
           tenant_id,
           owner_token AS lease_token
      FROM bumped_address
  )
  SELECT b.work_kind, to_jsonb(s), b.lease_token
    FROM bumped b
    JOIN public.form_submission s
      ON s.id = b.form_submission_id
     AND s.tenant_id = b.tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_form_payment_reconciliation_work()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_form_payment_reconciliation_work()
  TO service_role;