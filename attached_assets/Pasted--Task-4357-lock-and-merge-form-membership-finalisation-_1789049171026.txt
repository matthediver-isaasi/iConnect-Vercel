-- Task #4357: lock and merge form membership finalisation progress without
-- replacing unrelated payment_meta keys written by another worker.
CREATE OR REPLACE FUNCTION merge_form_membership_result(
  p_tenant_id UUID,
  p_submission_id UUID,
  p_patch JSONB,
  p_expected JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  s form_submission%ROWTYPE;
  current_result JSONB;
  k TEXT;
  v JSONB;
BEGIN
  IF p_tenant_id IS NULL OR p_submission_id IS NULL
     OR jsonb_typeof(COALESCE(p_patch, '{}'::JSONB)) <> 'object'
     OR jsonb_typeof(COALESCE(p_expected, '{}'::JSONB)) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGUMENT');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::TEXT || ':form-membership:' || p_submission_id::TEXT, 0));
  SELECT * INTO s FROM form_submission
   WHERE id = p_submission_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUBMISSION_NOT_FOUND');
  END IF;
  current_result := COALESCE(s.payment_meta->'membership_result', '{}'::JSONB);
  FOR k, v IN SELECT key, value FROM jsonb_each(COALESCE(p_expected, '{}'::JSONB))
  LOOP
    IF COALESCE(current_result->k, 'null'::JSONB) IS DISTINCT FROM v THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PROGRESS_CHANGED',
        'membership_result', current_result);
    END IF;
  END LOOP;
  current_result := current_result || p_patch
    || jsonb_build_object('updated_at', NOW());
  UPDATE form_submission
     SET payment_meta = COALESCE(payment_meta, '{}'::JSONB)
       || jsonb_build_object('membership_result', current_result)
   WHERE id = p_submission_id AND tenant_id = p_tenant_id;
  RETURN jsonb_build_object('ok', true, 'membership_result', current_result);
END; $$;

REVOKE ALL ON FUNCTION merge_form_membership_result(UUID, UUID, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_form_membership_result(UUID, UUID, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION merge_form_membership_result(UUID, UUID, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION merge_form_membership_result(UUID, UUID, JSONB, JSONB) TO service_role;

-- Atomically adopt an invoice found by the provider's read-only exact-PI
-- discovery. The caller has already verified financial/owner identity; this
-- function re-verifies durable local ownership and the exact stale claim.
CREATE OR REPLACE FUNCTION link_recovered_form_membership_invoice(
  p_tenant_id UUID, p_submission_id UUID, p_history_id UUID,
  p_invoice_id TEXT, p_invoice_number TEXT, p_provider TEXT,
  p_provider_context JSONB, p_expected_claimed_at TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  s form_submission%ROWTYPE;
  r JSONB;
  target TEXT;
  history_entity UUID;
  expected_entity UUID;
BEGIN
  IF p_invoice_id IS NULL OR p_provider NOT IN ('xero', 'quickbooks')
     OR p_provider_context IS NULL OR p_expected_claimed_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGUMENT');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::TEXT || ':form-membership:' || p_submission_id::TEXT, 0));
  SELECT * INTO s FROM form_submission
   WHERE id=p_submission_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR s.payment_provider <> 'stripe' OR s.payment_status <> 'paid' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SUBMISSION');
  END IF;
  r := COALESCE(s.payment_meta->'membership_result', '{}'::JSONB);
  IF r->>'invoice_state' <> 'processing'
     OR r->>'invoice_claimed_at' IS DISTINCT FROM p_expected_claimed_at
     OR r->>'history_id' IS DISTINCT FROM p_history_id::TEXT
     OR r->>'accounting_provider' IS DISTINCT FROM p_provider
     OR COALESCE(r->'provider_context', 'null'::JSONB) IS DISTINCT FROM p_provider_context THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PROGRESS_CHANGED');
  END IF;
  target := s.payment_meta->'membership'->'quote'->>'target';
  expected_entity := CASE WHEN target='member' THEN s.created_member_id
    ELSE COALESCE(s.organization_id, (s.payment_meta->>'prefill_organization_id')::UUID) END;
  IF target='member' THEN
    UPDATE member_membership_history SET
      accounting_provider=p_provider, accounting_invoice_id=p_invoice_id,
      accounting_invoice_number=p_invoice_number,
      xero_invoice_id=CASE WHEN p_provider='xero' THEN p_invoice_id ELSE xero_invoice_id END,
      xero_invoice_number=CASE WHEN p_provider='xero' THEN p_invoice_number ELSE xero_invoice_number END
    WHERE id=p_history_id AND tenant_id=p_tenant_id AND member_id=expected_entity
      AND stripe_payment_intent_id=s.payment_reference AND payment_status='paid'
      AND billing_agreement_id IS NULL AND accounting_invoice_id IS NULL
    RETURNING member_id INTO history_entity;
  ELSIF target='organization' THEN
    UPDATE organisation_membership_history SET
      accounting_provider=p_provider, accounting_invoice_id=p_invoice_id,
      accounting_invoice_number=p_invoice_number,
      xero_invoice_id=CASE WHEN p_provider='xero' THEN p_invoice_id ELSE xero_invoice_id END,
      xero_invoice_number=CASE WHEN p_provider='xero' THEN p_invoice_number ELSE xero_invoice_number END
    WHERE id=p_history_id AND tenant_id=p_tenant_id AND organization_id=expected_entity
      AND stripe_payment_intent_id=s.payment_reference AND payment_status='paid'
      AND billing_agreement_id IS NULL AND accounting_invoice_id IS NULL
    RETURNING organization_id INTO history_entity;
  ELSE
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TARGET');
  END IF;
  IF history_entity IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'HISTORY_CHANGED');
  END IF;
  r := r || jsonb_build_object(
    'invoice_state','done', 'invoice_number',p_invoice_number,
    'accounting_provider',p_provider, 'provider_context',p_provider_context,
    'settlement_state','pending', 'updated_at',NOW());
  UPDATE form_submission SET payment_meta=COALESCE(payment_meta,'{}'::JSONB)
    || jsonb_build_object('membership_result',r)
   WHERE id=p_submission_id AND tenant_id=p_tenant_id;
  RETURN jsonb_build_object('ok',true,'membership_result',r);
END; $$;

REVOKE ALL ON FUNCTION link_recovered_form_membership_invoice(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION link_recovered_form_membership_invoice(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION link_recovered_form_membership_invoice(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION link_recovered_form_membership_invoice(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT) TO service_role;