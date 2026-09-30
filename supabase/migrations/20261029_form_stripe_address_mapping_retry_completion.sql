-- Task #4446 follow-up: an immutable Stripe snapshot is only half of address
-- completion when persisted mappings exist. Keep that row on the fair retry
-- queue until its atomic mapping ledger is present. The 20261028 migration is
-- already installed, so these replacements intentionally live in a new file.

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
  SELECT s.id, s.tenant_id
    FROM public.form_submission s
   WHERE (
       (s.payment_provider = 'stripe' AND s.payment_status = 'paid')
       OR (s.payment_provider = 'stripe_monthly_card' AND s.payment_status = 'setup_complete')
     )
     AND (
       s.payment_meta ? 'membership'
       OR (jsonb_typeof(s.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
           AND jsonb_array_length(s.payment_meta->'stripe_address_mapping_config'->'mappings') > 0)
     )
     AND (
       s.payment_meta->'stripe_billing_address' IS NULL
       OR (
         jsonb_typeof(s.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
         AND jsonb_array_length(s.payment_meta->'stripe_address_mapping_config'->'mappings') > 0
         AND NOT EXISTS (
           SELECT 1 FROM public.form_stripe_address_mapping_ledger ledger
            WHERE ledger.form_submission_id = s.id AND ledger.tenant_id = s.tenant_id
         )
       )
     )
     AND COALESCE(s.payment_meta->'completion'->>'status', '') <> 'attention'
  ON CONFLICT (form_submission_id) DO NOTHING;

  RETURN QUERY
  WITH due AS (
    SELECT r.form_submission_id
      FROM public.form_stripe_address_mapping_retry r
      JOIN public.form_submission s
        ON s.id = r.form_submission_id AND s.tenant_id = r.tenant_id
     WHERE r.next_attempt_at <= NOW()
       AND (r.claimed_at IS NULL OR r.claimed_at < NOW() - INTERVAL '5 minutes')
       AND (
         (s.payment_provider = 'stripe' AND s.payment_status = 'paid')
         OR (s.payment_provider = 'stripe_monthly_card' AND s.payment_status = 'setup_complete')
       )
       AND (
         s.payment_meta->'stripe_billing_address' IS NULL
         OR (
           jsonb_typeof(s.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
           AND jsonb_array_length(s.payment_meta->'stripe_address_mapping_config'->'mappings') > 0
           AND NOT EXISTS (
             SELECT 1 FROM public.form_stripe_address_mapping_ledger ledger
              WHERE ledger.form_submission_id = s.id AND ledger.tenant_id = s.tenant_id
           )
         )
       )
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

CREATE OR REPLACE FUNCTION public.finish_form_stripe_address_mapping_retry(
  p_tenant_id UUID, p_submission_id UUID, p_owner_token UUID,
  p_succeeded BOOLEAN, p_error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_has_mappings BOOLEAN;
BEGIN
  IF p_succeeded THEN
    SELECT COALESCE(
             jsonb_typeof(s.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
             AND jsonb_array_length(s.payment_meta->'stripe_address_mapping_config'->'mappings') > 0,
             FALSE)
      INTO v_has_mappings
      FROM public.form_submission s
     WHERE s.id = p_submission_id AND s.tenant_id = p_tenant_id;

    -- Mapping completion is the ledger, not merely snapshot capture. Clearing
    -- this marker lets a previously done pipeline return a non-partial result.
    IF v_has_mappings THEN
      UPDATE public.form_submission s
         SET payment_meta = jsonb_set(
           COALESCE(s.payment_meta, '{}'::JSONB),
           '{stripe_address_mappings_pending}', 'false'::JSONB, true)
       WHERE s.id = p_submission_id AND s.tenant_id = p_tenant_id
         AND EXISTS (
           SELECT 1 FROM public.form_stripe_address_mapping_ledger ledger
            WHERE ledger.form_submission_id = s.id AND ledger.tenant_id = s.tenant_id
         );
    END IF;

    DELETE FROM public.form_stripe_address_mapping_retry r
     WHERE r.form_submission_id = p_submission_id AND r.tenant_id = p_tenant_id
       AND r.owner_token = p_owner_token
       AND EXISTS (
         SELECT 1 FROM public.form_submission s
          WHERE s.id = r.form_submission_id AND s.tenant_id = r.tenant_id
            AND (
              (NOT v_has_mappings AND s.payment_meta->'stripe_billing_address' IS NOT NULL)
              OR (v_has_mappings AND EXISTS (
                SELECT 1 FROM public.form_stripe_address_mapping_ledger ledger
                 WHERE ledger.form_submission_id = s.id AND ledger.tenant_id = s.tenant_id
              ))
            )
       );
  ELSE
    UPDATE public.form_stripe_address_mapping_retry
       SET claimed_at = NULL, owner_token = NULL,
           last_error = LEFT(COALESCE(p_error, 'retry incomplete'), 2000)
     WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id
       AND owner_token = p_owner_token;
  END IF;
END;
$$;

-- `followup` is still exceptional. Address-target recovery joins it only when
-- process-application wrote the durable pending marker.
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
           OR COALESCE((s.payment_meta->>'stripe_address_mappings_pending')::BOOLEAN, FALSE)
         )
    ) THEN
      RETURN jsonb_build_object('status', 'done');
    END IF;
    UPDATE public.form_paid_pipeline_operation
       SET operation_id = p_operation_id, operation_kind = p_operation_kind,
           status = 'processing', last_error = NULL, updated_at = NOW(), finished_at = NULL
     WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id;
    RETURN jsonb_build_object('status', 'claimed');
  END IF;
  IF v_row.operation_id = p_operation_id AND v_row.status = 'processing' THEN
    RETURN jsonb_build_object('status', 'claimed');
  END IF;
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

REVOKE ALL ON FUNCTION public.claim_form_stripe_address_mapping_retries(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_form_stripe_address_mapping_retry(UUID, UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_form_paid_pipeline_operation(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_form_stripe_address_mapping_retries(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_form_stripe_address_mapping_retry(UUID, UUID, UUID, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_form_paid_pipeline_operation(UUID, UUID, UUID, TEXT) TO service_role;