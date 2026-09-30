-- Task #3680 — Add a UNIQUE partial index on member_membership_history.billing_agreement_id
-- so that concurrent form monthly-card checkout finalisations cannot insert
-- duplicate history rows for the same billing agreement, and so that
-- INSERT ... ON CONFLICT (via error code 23505) is a reliable idempotency guard.
--
-- A plain (non-unique) index already exists from 20260726_gocardless_phase2_dd_config.sql;
-- this adds the uniqueness constraint on top, as a separate partial index that
-- only covers non-NULL values (NULL billing_agreement_id = one-off/annual rows,
-- which have no such constraint).
--
-- Idempotent: IF NOT EXISTS means it is safe to re-run.
--
-- Compatibility: PostgreSQL 9.5+ supports unique partial indexes. Supabase
-- (Postgres 14/15) is fully compatible.

CREATE UNIQUE INDEX IF NOT EXISTS member_membership_history_billing_agreement_uniq
  ON member_membership_history (billing_agreement_id)
  WHERE billing_agreement_id IS NOT NULL;

-- A member can have only one membership record for a membership year,
-- regardless of whether it is annual, monthly card, or monthly Direct Debit.
-- This is the final database guard behind every application-level precheck.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM member_membership_history
     GROUP BY tenant_id, member_id, membership_year
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce one membership per member/year: duplicate member_membership_history rows must be reviewed first';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS member_membership_history_member_year_uniq
  ON member_membership_history (tenant_id, member_id, membership_year);

-- Atomically attach a form-originated Stripe agreement to the member resolved
-- after Checkout and reserve/insert that member's membership-year row. A
-- transaction-scoped advisory lock serializes competing form attempts before
-- the unique index supplies the final cross-path protection.
DROP FUNCTION IF EXISTS claim_form_monthly_card_membership(UUID, UUID, UUID, JSONB);

CREATE OR REPLACE FUNCTION claim_form_monthly_card_membership(
  p_agreement_id UUID,
  p_submission_id UUID,
  p_member_id UUID,
  p_history JSONB DEFAULT '{}'::JSONB,
  p_reserve_only BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_agreement membership_billing_agreements%ROWTYPE;
  v_year TEXT;
  v_history_id UUID;
  v_conflict_history_id UUID;
  v_conflict_agreement_id UUID;
BEGIN
  SELECT *
    INTO v_agreement
    FROM membership_billing_agreements
   WHERE id = p_agreement_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_agreement.provider <> 'stripe'
     OR v_agreement.agreement_type <> 'member'
     OR COALESCE(v_agreement.metadata->>'form_submission_id', '') <> p_submission_id::TEXT THEN
    RETURN jsonb_build_object(
      'ok', false,
      'conflict', false,
      'code', 'INVALID_AGREEMENT',
      'detail', 'The billing agreement does not match this form submission'
    );
  END IF;

  v_year := NULLIF(v_agreement.metadata->'card'->>'membership_year', '');
  IF v_year IS NULL OR p_member_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'conflict', false,
      'code', 'INVALID_MEMBERSHIP_IDENTITY',
      'detail', 'The member or membership year is missing'
    );
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_agreement.tenant_id::TEXT || ':' || p_member_id::TEXT || ':' || v_year, 0)
  );

  SELECT id
    INTO v_history_id
    FROM member_membership_history
   WHERE billing_agreement_id = p_agreement_id
   LIMIT 1;
  IF v_history_id IS NOT NULL THEN
    IF v_agreement.member_id IS NOT NULL AND v_agreement.member_id <> p_member_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'conflict', true,
        'code', 'AGREEMENT_MEMBER_MISMATCH',
        'detail', 'The agreement is already attached to another member'
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'history_id', v_history_id
    );
  END IF;

  SELECT id
    INTO v_conflict_history_id
    FROM member_membership_history
   WHERE tenant_id = v_agreement.tenant_id
     AND member_id = p_member_id
     AND membership_year = v_year
   LIMIT 1;
  IF v_conflict_history_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'conflict', true,
      'code', 'MEMBERSHIP_YEAR_EXISTS',
      'detail', 'Membership for this year is already recorded',
      'history_id', v_conflict_history_id
    );
  END IF;

  SELECT id
    INTO v_conflict_agreement_id
    FROM membership_billing_agreements
   WHERE tenant_id = v_agreement.tenant_id
     AND member_id = p_member_id
     AND id <> p_agreement_id
     AND status IN (
       'payment_setup_required',
       'mandate_pending',
       'first_payment_pending',
       'active',
       'payment_grace_period',
       'payment_overdue'
     )
     AND COALESCE(
       metadata->'card'->>'membership_year',
       metadata->'dd'->>'membership_year'
     ) = v_year
   LIMIT 1;
  IF v_conflict_agreement_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'conflict', true,
      'code', 'OPEN_MEMBERSHIP_AGREEMENT_EXISTS',
      'detail', 'A monthly payment agreement already exists for this membership year',
      'agreement_id', v_conflict_agreement_id
    );
  END IF;

  UPDATE membership_billing_agreements
     SET member_id = p_member_id,
         updated_at = NOW()
   WHERE id = p_agreement_id
     AND (member_id IS NULL OR member_id = p_member_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'conflict', true,
      'code', 'AGREEMENT_MEMBER_MISMATCH',
      'detail', 'The agreement was attached to another member concurrently'
    );
  END IF;

  -- Before Checkout, the open agreement itself is the cross-provider
  -- reservation. Do not create membership history until Checkout is verified:
  -- an abandoned or expired Checkout must not consume the member's year.
  IF p_reserve_only THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', v_agreement.member_id = p_member_id,
      'reserved', true,
      'history_id', NULL
    );
  END IF;

  BEGIN
    INSERT INTO member_membership_history (
      tenant_id,
      member_id,
      membership_year,
      config_id,
      band_id,
      tier_label,
      field_value,
      annual_cost,
      prorata_cost,
      free_period_discount,
      rollover_discount,
      custom_discount_total,
      custom_discount_details,
      final_cost,
      currency,
      billing_period,
      vat_rate_percent,
      vat_amount,
      total_with_vat,
      year_number,
      prorata_days,
      free_period_days_applied,
      payment_method,
      status,
      payment_status,
      billing_agreement_id,
      notes
    ) VALUES (
      v_agreement.tenant_id,
      p_member_id,
      v_year,
      NULLIF(p_history->>'config_id', '')::UUID,
      NULLIF(p_history->>'band_id', '')::UUID,
      NULLIF(p_history->>'tier_label', ''),
      p_history->>'field_value',
      NULLIF(p_history->>'annual_cost', '')::NUMERIC,
      NULL,
      0,
      0,
      0,
      NULL,
      COALESCE(
        NULLIF(p_history->>'plan_total', '')::NUMERIC,
        NULLIF(p_history->>'final_cost', '')::NUMERIC
      ),
      COALESCE(NULLIF(p_history->>'currency', ''), 'GBP'),
      'monthly_card',
      NULLIF(p_history->>'vat_rate_percent', '')::NUMERIC,
      COALESCE(NULLIF(p_history->>'vat_amount', '')::NUMERIC, 0),
      COALESCE(
        NULLIF(p_history->>'plan_total', '')::NUMERIC,
        NULLIF(p_history->>'total_with_vat', '')::NUMERIC,
        NULLIF(p_history->>'final_cost', '')::NUMERIC
      ),
      NULL,
      NULL,
      0,
      'card_monthly',
      'pending_payment_setup',
      'unpaid',
      p_agreement_id,
      'Monthly card plan started via form. Form submission: '
        || p_submission_id::TEXT || ' (monthly-card checkout).'
    )
    RETURNING id INTO v_history_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT id
        INTO v_history_id
        FROM member_membership_history
       WHERE billing_agreement_id = p_agreement_id
       LIMIT 1;
      IF v_history_id IS NOT NULL THEN
        RETURN jsonb_build_object(
          'ok', true,
          'idempotent', true,
          'history_id', v_history_id
        );
      END IF;
      SELECT id
        INTO v_conflict_history_id
        FROM member_membership_history
       WHERE tenant_id = v_agreement.tenant_id
         AND member_id = p_member_id
         AND membership_year = v_year
       LIMIT 1;
      RETURN jsonb_build_object(
        'ok', false,
        'conflict', true,
        'code', 'MEMBERSHIP_YEAR_EXISTS',
        'detail', 'Membership for this year was recorded concurrently',
        'history_id', v_conflict_history_id
      );
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'history_id', v_history_id
  );
END;
$$;

REVOKE ALL ON FUNCTION claim_form_monthly_card_membership(UUID, UUID, UUID, JSONB, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_form_monthly_card_membership(UUID, UUID, UUID, JSONB, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION claim_form_monthly_card_membership(UUID, UUID, UUID, JSONB, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_form_monthly_card_membership(UUID, UUID, UUID, JSONB, BOOLEAN) TO service_role;

-- A Stripe-confirmed expired Checkout is uncharged. Release every local
-- reservation/link in one transaction so another payment route or a fresh
-- application cannot be blocked by the abandoned attempt.
CREATE OR REPLACE FUNCTION release_expired_form_monthly_card_checkout(
  p_agreement_id UUID,
  p_checkout_session_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_agreement membership_billing_agreements%ROWTYPE;
  v_submission_id UUID;
BEGIN
  SELECT *
    INTO v_agreement
    FROM membership_billing_agreements
   WHERE id = p_agreement_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'AGREEMENT_NOT_FOUND',
      'detail', 'The billing agreement does not exist'
    );
  END IF;

  IF v_agreement.status = 'expired'
     AND v_agreement.metadata->>'expired_checkout_session_id' = p_checkout_session_id THEN
    RETURN jsonb_build_object('ok', true, 'released', true, 'idempotent', true);
  END IF;

  IF v_agreement.provider <> 'stripe'
     OR v_agreement.agreement_type <> 'member'
     OR COALESCE(v_agreement.metadata->>'form_submission_id', '') = ''
     OR COALESCE(v_agreement.stripe_checkout_session_id, '') <> p_checkout_session_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'INVALID_EXPIRED_CHECKOUT',
      'detail', 'The agreement does not match this form Checkout session'
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM membership_payment_plans
     WHERE billing_agreement_id = p_agreement_id
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'PAYMENT_PLAN_EXISTS',
      'detail', 'A payment plan exists, so the Checkout reservation cannot be released'
    );
  END IF;

  BEGIN
    v_submission_id := (v_agreement.metadata->>'form_submission_id')::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'INVALID_FORM_SUBMISSION',
        'detail', 'The agreement form submission id is invalid'
      );
  END;

  DELETE FROM member_membership_history
   WHERE billing_agreement_id = p_agreement_id
     AND status = 'pending_payment_setup'
     AND payment_status = 'unpaid';

  UPDATE form_submission
     SET payment_meta = (
       (COALESCE(payment_meta, '{}'::JSONB) #- '{monthly_card,checkout_url}')
         #- '{monthly_card,checkout_session_id}'
     )
   WHERE id = v_submission_id
     AND payment_status = 'pending';

  UPDATE membership_billing_agreements
     SET status = 'expired',
         member_id = NULL,
         idempotency_key = 'expired-form-card:' || id::TEXT || ':' || p_checkout_session_id,
         stripe_checkout_session_id = NULL,
         stripe_subscription_id = NULL,
         redirect_url = NULL,
         needs_attention = false,
         attention_reason = NULL,
         metadata = COALESCE(metadata, '{}'::JSONB)
           || jsonb_build_object(
             'expired_checkout_session_id', p_checkout_session_id,
             'expired_checkout_released_at', NOW()
           ),
         updated_at = NOW()
   WHERE id = p_agreement_id;

  RETURN jsonb_build_object('ok', true, 'released', true, 'idempotent', false);
END;
$$;

REVOKE ALL ON FUNCTION release_expired_form_monthly_card_checkout(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_expired_form_monthly_card_checkout(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION release_expired_form_monthly_card_checkout(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION release_expired_form_monthly_card_checkout(UUID, TEXT) TO service_role;

-- Durable idempotency accepted by the workflow engine for membership-paid
-- dispatch. The caller may retry a pending/failed delivery, while a completed
-- key is never executed again.
CREATE TABLE IF NOT EXISTS workflow_delivery_claim (
  delivery_key TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  owner_token UUID,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_delivery_claim_status_idx
  ON workflow_delivery_claim (status, claimed_at);

ALTER TABLE workflow_delivery_claim ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE workflow_delivery_claim FROM PUBLIC;
REVOKE ALL ON TABLE workflow_delivery_claim FROM anon;
REVOKE ALL ON TABLE workflow_delivery_claim FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE workflow_delivery_claim TO service_role;
