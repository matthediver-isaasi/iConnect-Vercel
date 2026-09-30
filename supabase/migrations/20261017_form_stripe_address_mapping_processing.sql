-- Atomic, retry-safe application of immutable Stripe billing-address mappings.
CREATE TABLE IF NOT EXISTS public.form_submission_entity_creation (
  form_submission_id UUID NOT NULL REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('member', 'organization')),
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (form_submission_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS public.form_stripe_address_mapping_ledger (
  form_submission_id UUID PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  member_id UUID,
  organization_id UUID,
  mappings JSONB NOT NULL,
  stripe_billing_address JSONB NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.form_stripe_address_mapping_target (
  form_submission_id UUID NOT NULL REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('member', 'organization')),
  entity_id UUID NOT NULL,
  checkpointed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (form_submission_id, entity_type)
);

CREATE TABLE IF NOT EXISTS public.form_stripe_address_mapping_processing_lease (
  form_submission_id UUID PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  lease_token UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION public.claim_form_stripe_address_mapping_processing(
  p_tenant_id UUID, p_submission_id UUID, p_token UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_claimed UUID;
BEGIN
  INSERT INTO public.form_stripe_address_mapping_processing_lease
    (form_submission_id, tenant_id, lease_token, expires_at)
  VALUES (p_submission_id, p_tenant_id, p_token, NOW() + INTERVAL '5 minutes')
  ON CONFLICT (form_submission_id) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id,
        lease_token = EXCLUDED.lease_token,
        expires_at = EXCLUDED.expires_at
    WHERE form_stripe_address_mapping_processing_lease.expires_at < NOW()
      AND form_stripe_address_mapping_processing_lease.tenant_id = EXCLUDED.tenant_id
  RETURNING lease_token INTO v_claimed;
  RETURN COALESCE(v_claimed = p_token, FALSE);
END $$;

CREATE OR REPLACE FUNCTION public.release_form_stripe_address_mapping_processing(
  p_tenant_id UUID, p_submission_id UUID, p_token UUID
) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM public.form_stripe_address_mapping_processing_lease
   WHERE form_submission_id = p_submission_id
     AND tenant_id = p_tenant_id
     AND lease_token = p_token
$$;

-- Retry scheduling is intentionally separate from payment_meta: independent
-- workers never race by replacing checkout/finalization metadata, and poison
-- submissions receive backoff instead of monopolising a bounded cron batch.
CREATE TABLE IF NOT EXISTS public.form_stripe_address_mapping_retry (
  form_submission_id UUID PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS form_stripe_address_mapping_retry_due_idx
  ON public.form_stripe_address_mapping_retry (next_attempt_at, created_at, form_submission_id);

CREATE INDEX IF NOT EXISTS form_submission_entity_creation_tenant_idx
  ON public.form_submission_entity_creation (tenant_id, form_submission_id);

-- Top-level payment metadata is shared by independent payment, finalization,
-- and address workers. Merge under a row lock so none of those workers can
-- replace a newer sibling key with a stale whole-object snapshot.
CREATE OR REPLACE FUNCTION public.patch_form_submission_payment_meta(
  p_tenant_id UUID,
  p_submission_id UUID,
  p_patch JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_meta JSONB;
BEGIN
  IF jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'payment metadata patch must be an object'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.form_submission
     SET payment_meta = COALESCE(payment_meta, '{}'::JSONB) || p_patch
   WHERE id = p_submission_id AND tenant_id = p_tenant_id
   RETURNING payment_meta INTO v_meta;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'form submission not found'
      USING ERRCODE = 'P0002';
  END IF;
  RETURN v_meta;
END;
$$;

-- Register every currently unfinished obligation before claiming only due
-- rows. Completion is anti-joined in the database before LIMIT, while each
-- claim advances next_attempt_at. Thus both completed history and a batch of
-- repeatedly failing rows cannot starve later work.
CREATE OR REPLACE FUNCTION public.claim_form_stripe_address_mapping_retries(
  p_limit INTEGER DEFAULT 20
) RETURNS TABLE(submission JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'retry claim limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  -- Configuration/provider/status can legitimately change before payment is
  -- established (or old deployments may have snapshotted mappings on a
  -- non-Stripe attempt). Remove those stale obligations rather than retaining
  -- an unclaimable queue row forever.
  DELETE FROM public.form_stripe_address_mapping_retry retry
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.form_submission submission_row
      WHERE submission_row.id = retry.form_submission_id
        AND submission_row.tenant_id = retry.tenant_id
        AND (
          (submission_row.payment_provider = 'stripe' AND submission_row.payment_status = 'paid')
          OR
          (submission_row.payment_provider = 'stripe_monthly_card' AND submission_row.payment_status = 'setup_complete')
        )
        AND jsonb_typeof(submission_row.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
        AND jsonb_array_length(submission_row.payment_meta->'stripe_address_mapping_config'->'mappings') > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.form_stripe_address_mapping_ledger ledger
           WHERE ledger.form_submission_id = submission_row.id
        )
   );

  INSERT INTO public.form_stripe_address_mapping_retry (
    form_submission_id, tenant_id
  )
  SELECT submission_row.id, submission_row.tenant_id
    FROM public.form_submission submission_row
   WHERE (
       (submission_row.payment_provider = 'stripe' AND submission_row.payment_status = 'paid')
       OR
       (submission_row.payment_provider = 'stripe_monthly_card' AND submission_row.payment_status = 'setup_complete')
     )
     AND jsonb_typeof(submission_row.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
     AND jsonb_array_length(submission_row.payment_meta->'stripe_address_mapping_config'->'mappings') > 0
     AND NOT EXISTS (
       SELECT 1
         FROM public.form_stripe_address_mapping_ledger ledger
        WHERE ledger.form_submission_id = submission_row.id
     )
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
       AND (
         (submission_row.payment_provider = 'stripe' AND submission_row.payment_status = 'paid')
         OR
         (submission_row.payment_provider = 'stripe_monthly_card' AND submission_row.payment_status = 'setup_complete')
       )
       AND jsonb_typeof(submission_row.payment_meta->'stripe_address_mapping_config'->'mappings') = 'array'
       AND jsonb_array_length(submission_row.payment_meta->'stripe_address_mapping_config'->'mappings') > 0
       AND NOT EXISTS (
         SELECT 1
           FROM public.form_stripe_address_mapping_ledger ledger
          WHERE ledger.form_submission_id = retry.form_submission_id
       )
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
    JOIN public.form_submission submission_row
      ON submission_row.id = claimed.form_submission_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_form_stripe_address_mapping_retry(
  p_tenant_id UUID,
  p_submission_id UUID,
  p_succeeded BOOLEAN,
  p_error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_succeeded THEN
    -- Never discard an obligation merely because a caller says it succeeded:
    -- the immutable ledger remains the sole completion authority.
    DELETE FROM public.form_stripe_address_mapping_retry retry
     WHERE retry.form_submission_id = p_submission_id
       AND retry.tenant_id = p_tenant_id
       AND EXISTS (
         SELECT 1 FROM public.form_stripe_address_mapping_ledger ledger
          WHERE ledger.form_submission_id = retry.form_submission_id
            AND ledger.tenant_id = retry.tenant_id
       );
  ELSE
    UPDATE public.form_stripe_address_mapping_retry
       SET claimed_at = NULL,
           last_error = LEFT(COALESCE(p_error, 'retry incomplete'), 2000)
     WHERE form_submission_id = p_submission_id
       AND tenant_id = p_tenant_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_form_stripe_address_mappings(
  p_tenant_id UUID,
  p_submission_id UUID,
  p_member_id UUID,
  p_organization_id UUID,
  p_mappings JSONB,
  p_address JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission public.form_submission%ROWTYPE;
  v_mapping JSONB;
  v_entity TEXT;
  v_type TEXT;
  v_field TEXT;
  v_source TEXT;
  v_value TEXT;
  v_target UUID;
  v_scope TEXT;
  v_paid_invoice_ids JSONB;
  v_country_code TEXT;
  v_field_json JSONB;
  v_selected_countries JSONB;
  v_allowed_member_core CONSTANT TEXT[] := ARRAY[]::TEXT[];
  v_allowed_org_core CONSTANT TEXT[] := ARRAY['invoicing_address'];
BEGIN
  SELECT * INTO v_submission
    FROM public.form_submission
   WHERE id = p_submission_id AND tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUBMISSION_NOT_FOUND');
  END IF;
  IF EXISTS (SELECT 1 FROM public.form_stripe_address_mapping_ledger WHERE form_submission_id = p_submission_id) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'ALREADY_APPLIED', 'applied', false);
  END IF;
  IF v_submission.payment_provider NOT IN ('stripe', 'stripe_monthly_card') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_PROVIDER_INVALID');
  END IF;
  IF v_submission.payment_provider = 'stripe' AND v_submission.payment_status <> 'paid' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_NOT_PAID');
  END IF;
  IF v_submission.payment_provider = 'stripe_monthly_card' THEN
    IF v_submission.payment_status <> 'setup_complete' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FIRST_PAYMENT_NOT_PAID');
    END IF;
    SELECT plan.metadata->'paid_invoice_ids' INTO v_paid_invoice_ids
      FROM public.membership_payment_plans plan
     WHERE plan.billing_agreement_id = (v_submission.payment_meta->'monthly_card'->>'agreement_id')::UUID
     LIMIT 1;
    IF jsonb_typeof(v_paid_invoice_ids) <> 'array' OR jsonb_array_length(v_paid_invoice_ids) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FIRST_PAYMENT_NOT_PAID');
    END IF;
  END IF;
  IF v_submission.payment_meta->'stripe_address_mapping_config' IS NULL
     OR v_submission.payment_meta->'stripe_billing_address' IS NULL
     OR p_mappings IS DISTINCT FROM v_submission.payment_meta->'stripe_address_mapping_config'->'mappings'
     OR UPPER(COALESCE(p_address->>'country_code', '')) IS DISTINCT FROM
        UPPER(COALESCE(v_submission.payment_meta->'stripe_billing_address'->>'country', ''))
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY['line1','line2','city','state','postal_code','formatted']) source_key
        WHERE COALESCE(p_address->>source_key, '') IS DISTINCT FROM
              COALESCE(v_submission.payment_meta->'stripe_billing_address'->>source_key, '')
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_SNAPSHOT_MISMATCH');
  END IF;
  v_country_code := UPPER(p_address->>'country_code');
  IF NULLIF(v_country_code, '') IS NULL OR NULLIF(BTRIM(p_address->>'country'), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_SNAPSHOT_MISMATCH');
  END IF;
  -- Validation phase. It performs no writes and locks every referenced target
  -- and field definition so no later validation failure can commit a prefix of
  -- the mapping list without its ledger.
  FOR v_mapping IN SELECT value FROM jsonb_array_elements(p_mappings)
  LOOP
    v_entity := v_mapping->>'target_entity';
    v_type := v_mapping->>'target_type';
    v_field := v_mapping->>'target_field';
    v_source := v_mapping->>'source';
    IF v_source NOT IN ('line1','line2','city','state','postal_code','country','formatted')
       OR v_entity NOT IN ('member','organization')
       OR v_type NOT IN ('core','custom')
       OR NULLIF(v_field, '') IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_MAPPING');
    END IF;
    v_target := CASE WHEN v_entity = 'member' THEN p_member_id ELSE p_organization_id END;
    IF v_target IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TARGET_UNRESOLVED');
    END IF;
    IF v_entity = 'member' AND NOT EXISTS (
      SELECT 1 FROM public.member WHERE id = v_target AND tenant_id = p_tenant_id FOR KEY SHARE
    ) THEN RETURN jsonb_build_object('ok', false, 'code', 'TARGET_TENANT_MISMATCH');
    ELSIF v_entity = 'organization' AND NOT EXISTS (
      SELECT 1 FROM public.organization WHERE id = v_target AND tenant_id = p_tenant_id FOR KEY SHARE
    ) THEN RETURN jsonb_build_object('ok', false, 'code', 'TARGET_TENANT_MISMATCH');
    END IF;
    -- Service-role callers still cannot nominate an arbitrary same-tenant
    -- record. Authority must be persisted with the paid submission or derive
    -- from exact same-submission creation provenance.
    IF COALESCE((v_submission.payment_meta->>'verified_admin_access')::BOOLEAN, FALSE) IS NOT TRUE
       AND NOT EXISTS (
         SELECT 1 FROM public.form_submission_entity_creation creation
          WHERE creation.form_submission_id = p_submission_id
            AND creation.tenant_id = p_tenant_id
            AND creation.entity_type = v_entity
            AND creation.entity_id = v_target
       )
       AND NOT (
         v_entity = 'member'
         AND v_submission.payment_meta->>'verified_submitter_member_id' = v_target::TEXT
         AND EXISTS (
           SELECT 1 FROM public.member authorized_member
            WHERE authorized_member.id = v_target
              AND authorized_member.tenant_id = p_tenant_id
              AND LOWER(BTRIM(COALESCE(to_jsonb(authorized_member)->>'email', '')))
                = LOWER(BTRIM(COALESCE(to_jsonb(v_submission)->>'submitted_by_email', '')))
         )
       )
       AND NOT (
         v_entity = 'organization'
         AND EXISTS (
           SELECT 1 FROM public.member authorized_member
            WHERE authorized_member.id::TEXT = v_submission.payment_meta->>'verified_submitter_member_id'
              AND authorized_member.tenant_id = p_tenant_id
              AND to_jsonb(authorized_member)->>'organization_id' = v_target::TEXT
              AND LOWER(BTRIM(COALESCE(to_jsonb(authorized_member)->>'email', '')))
                = LOWER(BTRIM(COALESCE(to_jsonb(v_submission)->>'submitted_by_email', '')))
         )
       ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TARGET_MUTATION_FORBIDDEN');
    END IF;

    IF v_type = 'core' THEN
      IF (v_entity = 'member' AND NOT v_field = ANY(v_allowed_member_core))
         OR (v_entity = 'organization' AND NOT v_field = ANY(v_allowed_org_core)) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'CORE_FIELD_NOT_ALLOWED');
      END IF;
    ELSE
      v_scope := CASE WHEN v_entity = 'member' THEN 'member' ELSE 'organization' END;
      SELECT to_jsonb(field) INTO v_field_json
        FROM public.preference_field field
         WHERE id = v_field::UUID AND tenant_id = p_tenant_id
           AND is_active = TRUE AND entity_scope = v_scope
           AND field_type IN ('text', 'textarea', 'long_text', 'country')
           AND (field_type <> 'country' OR v_source = 'country')
         LIMIT 1
         FOR KEY SHARE;
      IF v_field_json IS NULL
         OR COALESCE((v_field_json->>'read_only')::BOOLEAN, FALSE)
         OR COALESCE((v_field_json->>'readonly')::BOOLEAN, FALSE)
         OR COALESCE((v_field_json->>'is_read_only')::BOOLEAN, FALSE)
         OR COALESCE((v_field_json->>'is_calculated')::BOOLEAN, FALSE)
         OR COALESCE((v_field_json->>'calculated')::BOOLEAN, FALSE)
         OR COALESCE((v_field_json->>'computed')::BOOLEAN, FALSE)
         OR COALESCE((v_field_json->>'writable')::BOOLEAN, TRUE) IS FALSE
         OR COALESCE((v_field_json->>'editable')::BOOLEAN, TRUE) IS FALSE
         OR NULLIF(BTRIM(v_field_json->>'formula'), '') IS NOT NULL
         OR NULLIF(BTRIM(v_field_json->>'calculation'), '') IS NOT NULL
         OR NULLIF(v_field_json->'calculation_config', 'null'::JSONB) IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'CUSTOM_FIELD_NOT_ALLOWED');
      END IF;
      IF v_field_json->>'field_type' = 'country' THEN
        v_selected_countries := v_field_json->'selected_countries';
        IF jsonb_typeof(v_selected_countries) = 'array'
           AND jsonb_array_length(v_selected_countries) > 0
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(v_selected_countries) selected
              WHERE UPPER(selected) = v_country_code
           ) THEN
          RETURN jsonb_build_object('ok', false, 'code', 'COUNTRY_NOT_ALLOWED');
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Write phase. Missing optional Stripe components are no-ops, never clears.
  -- Any SQL error is deliberately uncaught so PostgreSQL rolls back every
  -- earlier write and the ledger insert as one failed function statement.
  FOR v_mapping IN SELECT value FROM jsonb_array_elements(p_mappings)
  LOOP
    v_entity := v_mapping->>'target_entity';
    v_type := v_mapping->>'target_type';
    v_field := v_mapping->>'target_field';
    v_source := v_mapping->>'source';
    v_target := CASE WHEN v_entity = 'member' THEN p_member_id ELSE p_organization_id END;
    v_value := NULLIF(BTRIM(p_address->>v_source), '');
    IF v_value IS NULL THEN
      CONTINUE;
    END IF;

    IF v_type = 'core' THEN
      EXECUTE format('UPDATE public.%I SET %I = $1 WHERE id = $2 AND tenant_id = $3', v_entity, v_field)
        USING v_value, v_target, p_tenant_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Stripe address mapping target disappeared during write'
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      IF v_entity = 'member' THEN
        UPDATE public.member_preference_value SET value = v_value
         WHERE member_id = v_target AND field_id = v_field::UUID;
        IF NOT FOUND THEN
          INSERT INTO public.member_preference_value (member_id, field_id, value)
          VALUES (v_target, v_field::UUID, v_value);
        END IF;
      ELSE
        UPDATE public.organization_preference_value SET value = v_value
         WHERE organization_id = v_target AND field_id = v_field::UUID;
        IF NOT FOUND THEN
          INSERT INTO public.organization_preference_value (organization_id, field_id, value)
          VALUES (v_target, v_field::UUID, v_value);
        END IF;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.form_stripe_address_mapping_ledger (
    form_submission_id, tenant_id, member_id, organization_id, mappings, stripe_billing_address
  ) VALUES (
    p_submission_id, p_tenant_id, p_member_id, p_organization_id, p_mappings, p_address
  );
  DELETE FROM public.form_stripe_address_mapping_retry
   WHERE form_submission_id = p_submission_id AND tenant_id = p_tenant_id;
  RETURN jsonb_build_object('ok', true, 'applied', true);
END;
$$;

REVOKE ALL ON TABLE public.form_submission_entity_creation FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.form_stripe_address_mapping_ledger FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.form_stripe_address_mapping_target FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.form_stripe_address_mapping_processing_lease FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.form_stripe_address_mapping_retry FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.form_submission_entity_creation TO service_role;
GRANT ALL ON TABLE public.form_stripe_address_mapping_ledger TO service_role;
GRANT ALL ON TABLE public.form_stripe_address_mapping_target TO service_role;
GRANT ALL ON TABLE public.form_stripe_address_mapping_processing_lease TO service_role;
GRANT ALL ON TABLE public.form_stripe_address_mapping_retry TO service_role;
REVOKE ALL ON FUNCTION public.apply_form_stripe_address_mappings(UUID,UUID,UUID,UUID,JSONB,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_form_stripe_address_mappings(UUID,UUID,UUID,UUID,JSONB,JSONB) TO service_role;
REVOKE ALL ON FUNCTION public.claim_form_stripe_address_mapping_processing(UUID,UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_form_stripe_address_mapping_processing(UUID,UUID,UUID) TO service_role;
REVOKE ALL ON FUNCTION public.release_form_stripe_address_mapping_processing(UUID,UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_form_stripe_address_mapping_processing(UUID,UUID,UUID) TO service_role;
REVOKE ALL ON FUNCTION public.patch_form_submission_payment_meta(UUID,UUID,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patch_form_submission_payment_meta(UUID,UUID,JSONB) TO service_role;
REVOKE ALL ON FUNCTION public.claim_form_stripe_address_mapping_retries(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_form_stripe_address_mapping_retries(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.finish_form_stripe_address_mapping_retry(UUID,UUID,BOOLEAN,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_form_stripe_address_mapping_retry(UUID,UUID,BOOLEAN,TEXT) TO service_role;