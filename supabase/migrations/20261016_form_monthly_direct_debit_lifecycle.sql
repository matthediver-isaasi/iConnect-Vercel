-- Task #4333: applicant-owned, member-scoped GoCardless monthly DD lifecycle.
-- Both functions are server-only: clients cannot manufacture an agreement or
-- bind a member/history row by calling PostgREST directly.

CREATE OR REPLACE FUNCTION claim_form_monthly_direct_debit_applicant_agreement(
  p_tenant_id UUID, p_submission_id UUID, p_applicant_email TEXT,
  p_membership_year TEXT, p_agreement_key TEXT, p_environment TEXT,
  p_dd_snapshot JSONB, p_member_id UUID DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  s form_submission%ROWTYPE;
  a membership_billing_agreements%ROWTYPE;
  identity TEXT;
BEGIN
  IF p_tenant_id IS NULL OR p_submission_id IS NULL
     OR NULLIF(BTRIM(LOWER(p_applicant_email)), '') IS NULL
     OR NULLIF(BTRIM(p_membership_year), '') IS NULL
     OR p_agreement_key NOT LIKE 'form-dd-applicant:%'
     OR COALESCE(p_dd_snapshot->>'kind', '') <> 'monthly_direct_debit' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_APPLICANT_IDENTITY',
      'detail', 'Applicant Direct Debit identity is incomplete');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_agreement_key, 0));
  identity := substring(p_agreement_key FROM length('form-dd-applicant:') + 1);
  SELECT * INTO s FROM form_submission WHERE id = p_submission_id
    AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND OR s.payment_status <> 'pending'
     OR s.payment_provider NOT IN ('gocardless_monthly_dd', 'gocardless_direct_debit')
     OR BTRIM(LOWER(COALESCE(s.payment_meta->'monthly_direct_debit'->>'applicant_email',
                              s.submitted_by_email, ''))) <> BTRIM(LOWER(p_applicant_email))
     OR COALESCE(s.payment_meta->'membership'->'quote'->>'membership_year', '') <> p_membership_year
     OR COALESCE(s.payment_meta->'membership'->'quote'->>'membership_year', '') <>
        COALESCE(p_dd_snapshot->>'membership_year', p_membership_year) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_FORM_SUBMISSION',
      'detail', 'The pending form submission does not match this applicant, quote, and year');
  END IF;
  SELECT * INTO a FROM membership_billing_agreements
   WHERE tenant_id = p_tenant_id AND idempotency_key = p_agreement_key FOR UPDATE;
  IF FOUND THEN
    IF a.provider <> 'gocardless' OR a.agreement_type <> 'member'
       OR COALESCE(a.metadata->>'form_submission_id', '') <> p_submission_id::TEXT
       OR COALESCE(a.metadata->'dd'->>'membership_year', '') <> p_membership_year THEN
      RETURN jsonb_build_object('ok', false, 'code', 'AGREEMENT_CONFLICT',
        'detail', 'Existing agreement does not match the Direct Debit application');
    END IF;
    RETURN jsonb_build_object('ok', true, 'agreement', to_jsonb(a));
  END IF;
  INSERT INTO membership_billing_agreements
    (tenant_id, agreement_type, provider, member_id, status, idempotency_key, environment, metadata)
  VALUES (p_tenant_id, 'member', 'gocardless', p_member_id, 'payment_setup_required',
    p_agreement_key, p_environment, jsonb_build_object(
      'dd', p_dd_snapshot, 'form_submission_id', p_submission_id,
      'applicant_identity', identity, 'quote_snapshot',
      s.payment_meta->'membership'->'quote'))
  RETURNING * INTO a;
  RETURN jsonb_build_object('ok', true, 'agreement', to_jsonb(a));
END; $$;

REVOKE ALL ON FUNCTION claim_form_monthly_direct_debit_applicant_agreement(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_form_monthly_direct_debit_applicant_agreement(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) FROM anon;
REVOKE ALL ON FUNCTION claim_form_monthly_direct_debit_applicant_agreement(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_form_monthly_direct_debit_applicant_agreement(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) TO service_role;

CREATE OR REPLACE FUNCTION bind_form_monthly_direct_debit_membership(
  p_agreement_id UUID, p_submission_id UUID, p_member_id UUID, p_history JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE a membership_billing_agreements%ROWTYPE; s form_submission%ROWTYPE;
  h UUID; y TEXT; conflict_id UUID; v_snapshot JSONB;
BEGIN
  SELECT * INTO a FROM membership_billing_agreements WHERE id = p_agreement_id FOR UPDATE;
  y := NULLIF(a.metadata->'dd'->>'membership_year', '');
  v_snapshot := COALESCE(a.metadata->'dd', '{}'::JSONB);
  SELECT * INTO s FROM form_submission WHERE id=p_submission_id FOR UPDATE;
  IF NOT FOUND OR a.provider <> 'gocardless' OR a.agreement_type <> 'member'
     OR COALESCE(a.metadata->>'form_submission_id','') <> p_submission_id::TEXT
     OR s.tenant_id <> a.tenant_id OR s.payment_provider <> 'gocardless_monthly_dd'
     OR s.payment_status NOT IN ('pending','setup_complete')
     OR y IS NULL OR p_member_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM member WHERE id=p_member_id AND tenant_id=a.tenant_id) THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_AGREEMENT',
      'detail','The Direct Debit agreement does not match this submission');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(a.tenant_id::TEXT || ':' ||
    p_member_id::TEXT || ':' || y, 0));
  SELECT id INTO h FROM member_membership_history WHERE billing_agreement_id = p_agreement_id LIMIT 1;
  IF h IS NOT NULL THEN
    IF a.member_id IS NOT NULL AND a.member_id <> p_member_id THEN
      RETURN jsonb_build_object('ok',false,'conflict',true,'code','AGREEMENT_MEMBER_MISMATCH',
        'detail','Agreement is attached to another member');
    END IF;
    RETURN jsonb_build_object('ok',true,'idempotent',true,'history_id',h);
  END IF;
  SELECT id INTO conflict_id FROM member_membership_history
   WHERE tenant_id=a.tenant_id AND member_id=p_member_id AND membership_year=y LIMIT 1;
  IF conflict_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'conflict',true,'code','MEMBERSHIP_YEAR_EXISTS',
      'detail','Membership for this year is already recorded','history_id',conflict_id);
  END IF;
  IF EXISTS (SELECT 1 FROM membership_billing_agreements x
    WHERE x.tenant_id=a.tenant_id AND x.member_id=p_member_id AND x.id<>a.id
      AND x.status IN ('payment_setup_required','mandate_pending','first_payment_pending',
                       'active','payment_grace_period','payment_overdue')
      AND COALESCE(x.metadata->'dd'->>'membership_year',x.metadata->'card'->>'membership_year')=y) THEN
    RETURN jsonb_build_object('ok',false,'conflict',true,'code','OPEN_MEMBERSHIP_AGREEMENT_EXISTS',
      'detail','A monthly payment agreement already exists for this membership year');
  END IF;
  UPDATE membership_billing_agreements SET member_id=p_member_id, updated_at=NOW()
   WHERE id=a.id AND (member_id IS NULL OR member_id=p_member_id);
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'conflict',true,
    'code','AGREEMENT_MEMBER_MISMATCH','detail','Agreement member changed concurrently'); END IF;
  INSERT INTO member_membership_history
    (tenant_id,member_id,membership_year,config_id,band_id,tier_label,field_value,
     annual_cost,final_cost,currency,billing_period,vat_rate_percent,vat_amount,
     payment_method,status,payment_status,billing_agreement_id,notes,total_with_vat)
  VALUES (a.tenant_id,p_member_id,y,NULLIF(v_snapshot->>'config_id','')::UUID,
    NULLIF(v_snapshot->>'band_id','')::UUID,NULLIF(v_snapshot->>'tier_label',''),
    v_snapshot->>'field_value',NULLIF(v_snapshot->>'annual_cost','')::NUMERIC,
    NULLIF(COALESCE(v_snapshot->>'plan_total',v_snapshot->>'final_cost'),'')::NUMERIC,
    COALESCE(NULLIF(v_snapshot->>'currency',''),'GBP'),'monthly_direct_debit',
    NULLIF(v_snapshot->>'vat_rate_percent','')::NUMERIC,
    COALESCE(NULLIF(v_snapshot->>'vat_amount','')::NUMERIC,0),
    'direct_debit','pending_payment_setup','unpaid',a.id,
    'Monthly Direct Debit plan started via form. Form submission: '||p_submission_id::TEXT,
    NULLIF(COALESCE(v_snapshot->>'plan_total',v_snapshot->>'total_with_vat'),'')::NUMERIC)
  RETURNING id INTO h;
  RETURN jsonb_build_object('ok',true,'idempotent',false,'history_id',h);
EXCEPTION WHEN unique_violation THEN
  SELECT id INTO h FROM member_membership_history WHERE billing_agreement_id=p_agreement_id LIMIT 1;
  IF h IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'idempotent',true,'history_id',h); END IF;
  RETURN jsonb_build_object('ok',false,'conflict',true,'code','MEMBERSHIP_YEAR_EXISTS',
    'detail','Membership for this year was recorded concurrently');
END; $$;

REVOKE ALL ON FUNCTION bind_form_monthly_direct_debit_membership(UUID, UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION bind_form_monthly_direct_debit_membership(UUID, UUID, UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION bind_form_monthly_direct_debit_membership(UUID, UUID, UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION bind_form_monthly_direct_debit_membership(UUID, UUID, UUID, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';