-- A Stripe-funded membership needs the immutable payment-time address even
-- when the form configured no address field mappings.  Keep that prerequisite
-- on the existing fair/backoff retry queue rather than relying on a browser.
CREATE OR REPLACE FUNCTION public.claim_form_stripe_address_mapping_retries(
  p_limit INTEGER DEFAULT 20
) RETURNS TABLE(submission JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'retry claim limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.form_stripe_address_mapping_retry (form_submission_id, tenant_id)
  SELECT submission_row.id, submission_row.tenant_id
    FROM public.form_submission submission_row
   WHERE submission_row.payment_provider = 'stripe'
     AND submission_row.payment_status = 'paid'
     AND (
       submission_row.payment_meta ? 'membership'
       OR (
         jsonb_typeof(submission_row.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
         AND jsonb_array_length(submission_row.payment_meta->'stripe_address_mapping_config'->'mappings') > 0
       )
     )
     AND submission_row.payment_meta->'stripe_billing_address' IS NULL
  ON CONFLICT (form_submission_id) DO NOTHING;

  RETURN QUERY
  WITH due AS (
    SELECT retry.form_submission_id
      FROM public.form_stripe_address_mapping_retry retry
      JOIN public.form_submission submission_row
        ON submission_row.id = retry.form_submission_id
       AND submission_row.tenant_id = retry.tenant_id
     WHERE retry.next_attempt_at <= NOW()
       AND (retry.claimed_at IS NULL OR retry.claimed_at < NOW() - INTERVAL '5 minutes')
       AND submission_row.payment_provider = 'stripe'
       AND submission_row.payment_status = 'paid'
       AND submission_row.payment_meta->'stripe_billing_address' IS NULL
     ORDER BY retry.next_attempt_at, retry.created_at, retry.form_submission_id
     FOR UPDATE OF retry SKIP LOCKED
     LIMIT p_limit
  ), claimed AS (
    UPDATE public.form_stripe_address_mapping_retry retry
       SET claimed_at = NOW(),
           attempt_count = retry.attempt_count + 1,
           next_attempt_at = NOW() + make_interval(
             secs => LEAST(3600, 60 * POWER(2, LEAST(retry.attempt_count, 6))::INTEGER)
           )
      FROM due
     WHERE retry.form_submission_id = due.form_submission_id
     RETURNING retry.form_submission_id
  )
  SELECT to_jsonb(submission_row)
    FROM claimed
    JOIN public.form_submission submission_row ON submission_row.id = claimed.form_submission_id;
END;
$$;
CREATE OR REPLACE FUNCTION public.finish_form_stripe_address_mapping_retry(
  p_tenant_id UUID, p_submission_id UUID, p_succeeded BOOLEAN, p_error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_succeeded THEN
    DELETE FROM public.form_stripe_address_mapping_retry retry
     WHERE retry.form_submission_id = p_submission_id
       AND retry.tenant_id = p_tenant_id
       AND EXISTS (
         SELECT 1 FROM public.form_submission submission_row
          WHERE submission_row.id = retry.form_submission_id
            AND submission_row.tenant_id = retry.tenant_id
            AND submission_row.payment_meta->'stripe_billing_address' IS NOT NULL
       );
  ELSE
    UPDATE public.form_stripe_address_mapping_retry
       SET claimed_at = NULL,
           last_error = LEFT(COALESCE(p_error, 'retry incomplete'), 2000)
     WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id;
  END IF;
END;
$$;

-- These SECURITY DEFINER address-retry RPCs return and mutate paid
-- submission data.  Restrict the intermediate migration itself as well as
-- the later owner-fencing replacement migration.
REVOKE ALL ON FUNCTION public.claim_form_stripe_address_mapping_retries(INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_form_stripe_address_mapping_retry(UUID, UUID, BOOLEAN, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_form_stripe_address_mapping_retries(INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_form_stripe_address_mapping_retry(UUID, UUID, BOOLEAN, TEXT)
  TO service_role;