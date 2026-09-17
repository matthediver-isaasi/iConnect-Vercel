-- Explicit service-role-only recovery. Never scheduled automatically; no
-- provider, payment, invoice, reminder or workflow side effects are emitted.
BEGIN;
ALTER TABLE membership_payment_quote ADD COLUMN IF NOT EXISTS recovered_commitment JSONB;
CREATE TABLE IF NOT EXISTS rolling_membership_recovery_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id),
  history_type TEXT NOT NULL CHECK (history_type IN ('member', 'organisation')),
  history_id UUID NOT NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('agreement', 'payment_quote')),
  evidence_id UUID NOT NULL,
  original_history JSONB NOT NULL,
  commitment JSONB NOT NULL,
  recovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (history_type, history_id)
);
ALTER TABLE rolling_membership_recovery_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE rolling_membership_recovery_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE rolling_membership_recovery_audit TO service_role;

CREATE OR REPLACE FUNCTION recover_rolling_membership_commitment(
  p_tenant_id UUID,
  p_history_type TEXT,
  p_history_id UUID,
  p_expected_history JSONB,
  p_expected_agreement JSONB,
  p_expected_quote JSONB,
  p_commitment JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t TEXT; owner_column TEXT; owner_id UUID; h JSONB; a JSONB; q JSONB;
  evidence JSONB; saved_config JSONB; source_commitment JSONB; amount_source JSONB;
  config_id UUID; evidence_id UUID; evidence_type TEXT; field_name TEXT;
  evidence_start TEXT; expected_method TEXT; expected_frequency TEXT;
  original_history JSONB; result JSONB; cols TEXT;
BEGIN
  IF p_tenant_id IS NULL OR p_history_id IS NULL OR p_history_type NOT IN ('member','organisation')
    OR p_history_type IS NULL OR p_commitment->>'term_key' IS NULL THEN
    RAISE EXCEPTION 'Recovery requires a tenant, history identity and complete commitment';
  END IF;
  t := CASE WHEN p_history_type = 'member' THEN 'member_membership_history' ELSE 'organisation_membership_history' END;
  owner_column := CASE WHEN p_history_type = 'member' THEN 'member_id' ELSE 'organization_id' END;
  -- Read identity first, acquire the same entity lock as all creation paths,
  -- then reread and lock the actual row before checking any exported evidence.
  EXECUTE format('SELECT to_jsonb(x) FROM %I x WHERE id=$1 AND tenant_id=$2', t)
    INTO h USING p_history_id, p_tenant_id;
  IF h IS NULL THEN RAISE EXCEPTION 'Recovery history not found in selected tenant'; END IF;
  owner_id := (h->>owner_column)::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || p_tenant_id::text || ':' || owner_column || ':' || owner_id::text, 0));
  EXECUTE format('SELECT to_jsonb(x) FROM %I x WHERE id=$1 AND tenant_id=$2 FOR UPDATE', t)
    INTO h USING p_history_id, p_tenant_id;
  IF h IS NULL OR (h->>owner_column)::uuid IS DISTINCT FROM owner_id THEN RAISE EXCEPTION 'Recovery owner changed concurrently'; END IF;
  IF h->>'term_key' IS NOT NULL THEN
    IF rolling_commitment_fields(h) IS DISTINCT FROM rolling_commitment_fields(p_commitment) THEN
      RAISE EXCEPTION 'A different committed term is already recorded';
    END IF;
    RETURN jsonb_build_object('status','already_recorded','id',p_history_id);
  END IF;
  IF p_expected_history IS NULL OR NOT h @> p_expected_history
    OR p_expected_history->>'id' IS DISTINCT FROM p_history_id::text
    OR p_expected_history->>'tenant_id' IS DISTINCT FROM p_tenant_id::text
    OR p_expected_history->>owner_column IS DISTINCT FROM owner_id::text THEN
    RAISE EXCEPTION 'Recovery history changed since the dry-run evidence was exported';
  END IF;
  original_history := h;
  IF h->>'billing_agreement_id' IS NOT NULL THEN
    SELECT to_jsonb(x) INTO a FROM membership_billing_agreements x
      WHERE id=(h->>'billing_agreement_id')::uuid AND tenant_id=p_tenant_id FOR UPDATE;
    IF a IS NULL OR a->>owner_column IS DISTINCT FROM owner_id::text
      OR p_expected_agreement IS NULL OR NOT a @> p_expected_agreement
      OR p_expected_agreement->>'id' IS DISTINCT FROM a->>'id'
      OR p_expected_agreement->'metadata' IS DISTINCT FROM a->'metadata' THEN
      RAISE EXCEPTION 'Recovery agreement ownership/evidence changed or cannot be verified';
    END IF;
    evidence := COALESCE(a#>'{metadata,card}', a#>'{metadata,dd}');
    source_commitment := CASE WHEN a->>'term_key' IS NOT NULL THEN rolling_commitment_fields(a)
      ELSE COALESCE(NULLIF(a#>'{metadata,commitment}','null'::jsonb), NULLIF(evidence->'commitment','null'::jsonb)) END;
    evidence_id := (a->>'id')::uuid;
    evidence_type := 'agreement';
  ELSE
    IF p_expected_quote->>'id' IS NULL THEN RAISE EXCEPTION 'Recovery needs a durably linked payment quote'; END IF;
    SELECT to_jsonb(x) INTO q FROM membership_payment_quote x
      WHERE id=(p_expected_quote->>'id')::uuid AND tenant_id=p_tenant_id FOR UPDATE;
    IF q IS NULL OR q->>owner_column IS DISTINCT FROM owner_id::text
      OR (p_history_type='member' AND q->>'organization_id' IS NOT NULL)
      OR NOT q @> p_expected_quote OR p_expected_quote->'quote' IS DISTINCT FROM q->'quote' THEN
      RAISE EXCEPTION 'Recovery quote ownership/evidence changed or cannot be verified';
    END IF;
    IF NOT (
      h->>'membership_payment_quote_id' IS NOT DISTINCT FROM q->>'id'
      OR (h->>'stripe_payment_intent_id' IS NOT NULL
        AND h->>'stripe_payment_intent_id' IS NOT DISTINCT FROM q->>'stripe_payment_intent_id')
      OR q#>>'{quote,history_id}' IS NOT DISTINCT FROM h->>'id'
    ) THEN RAISE EXCEPTION 'Payment quote is not durably linked to this history row'; END IF;
    evidence := q->'quote';
    source_commitment := COALESCE(NULLIF(evidence#>'{simResult,commitment}','null'::jsonb),
      NULLIF(evidence->'commitment','null'::jsonb));
    evidence_id := (q->>'id')::uuid;
    evidence_type := 'payment_quote';
  END IF;
  IF source_commitment->>'term_key' IS NOT NULL THEN
    IF rolling_commitment_fields(source_commitment) IS DISTINCT FROM rolling_commitment_fields(p_commitment) THEN
      RAISE EXCEPTION 'Proposed recovery does not match the stored immutable commitment';
    END IF;
  ELSE
    saved_config := COALESCE(evidence->'config_snapshot', evidence->'config');
    IF saved_config IS NULL OR saved_config->>'start_mode' IS DISTINCT FROM 'immediate'
      OR saved_config->>'id' IS DISTINCT FROM evidence->>'config_id'
      OR saved_config IS DISTINCT FROM p_commitment#>'{commitment_snapshot,config}'
      OR saved_config->>'id' IS DISTINCT FROM p_commitment#>>'{commitment_snapshot,config_id}'
      OR saved_config->>'billing_period' IS DISTINCT FROM p_commitment#>>'{commitment_snapshot,billing_period}' THEN
      RAISE EXCEPTION 'Original immutable rolling configuration cannot be verified';
    END IF;
    evidence_start := COALESCE(evidence->>'term_start_date', evidence->>'membership_start_date', evidence->>'membership_year_start');
    IF evidence_start IS NULL OR evidence_start::date IS DISTINCT FROM (p_commitment->>'term_start_date')::date
      OR (p_commitment->>'term_anchor_date')::date IS DISTINCT FROM evidence_start::date
      OR p_commitment->>'previous_term_id' IS NOT NULL
      OR evidence->>'renewal_of_agreement_id' IS NOT NULL OR evidence->>'previous_term_id' IS NOT NULL
      OR a#>>'{metadata,previous_agreement_id}' IS NOT NULL THEN
      RAISE EXCEPTION 'Legacy commencement/anchor cannot be proved; administrator review required';
    END IF;
    FOREACH field_name IN ARRAY ARRAY['term_start_date','membership_start_date','membership_year_start','term_anchor_date'] LOOP
      IF evidence->>field_name IS NOT NULL AND (evidence->>field_name)::date IS DISTINCT FROM evidence_start::date THEN
        RAISE EXCEPTION 'Contradictory original membership dates';
      END IF;
    END LOOP;
    amount_source := COALESCE(evidence->'amounts', evidence);
    FOREACH field_name IN ARRAY ARRAY['annual_cost','final_cost','vat_amount','total_with_vat'] LOOP
      IF COALESCE(amount_source->>field_name, CASE WHEN field_name='total_with_vat' THEN amount_source->>'plan_total' END) IS NULL
        OR COALESCE(amount_source->>field_name, CASE WHEN field_name='total_with_vat' THEN amount_source->>'plan_total' END)::numeric
          IS DISTINCT FROM (p_commitment#>>ARRAY['commitment_snapshot','amounts',field_name])::numeric THEN
        RAISE EXCEPTION 'Original agreed amount % cannot be verified', field_name;
      END IF;
    END LOOP;
    FOREACH field_name IN ARRAY ARRAY['monthly_amount','instalment_count'] LOOP
      IF (amount_source->>field_name)::numeric IS DISTINCT FROM (p_commitment#>>ARRAY['commitment_snapshot','amounts',field_name])::numeric THEN
        RAISE EXCEPTION 'Original collection terms differ from recovery';
      END IF;
    END LOOP;
    IF amount_source->>'currency' IS DISTINCT FROM p_commitment#>>'{commitment_snapshot,amounts,currency}' THEN
      RAISE EXCEPTION 'Original agreed currency differs from recovery';
    END IF;
    expected_method := COALESCE(evidence->>'payment_method',
      CASE WHEN a->>'provider'='stripe' THEN 'card_monthly' WHEN a IS NOT NULL THEN 'direct_debit' END);
    expected_frequency := COALESCE(evidence->>'payment_frequency', CASE WHEN a IS NOT NULL THEN 'monthly' END);
    IF expected_method IS NULL OR expected_frequency IS NULL
      OR expected_method IS DISTINCT FROM p_commitment#>>'{commitment_snapshot,payment_method}'
      OR expected_frequency IS DISTINCT FROM p_commitment#>>'{commitment_snapshot,payment_frequency}' THEN
      RAISE EXCEPTION 'Original payment method/frequency cannot be verified';
    END IF;
  END IF;
  config_id := (p_commitment#>>'{commitment_snapshot,config_id}')::uuid;
  IF h->>'config_id' IS DISTINCT FROM config_id::text
    OR h->>'currency' IS DISTINCT FROM p_commitment#>>'{commitment_snapshot,amounts,currency}' THEN
    RAISE EXCEPTION 'Recorded configuration/currency differs from recovery evidence';
  END IF;
  FOREACH field_name IN ARRAY ARRAY['annual_cost','final_cost','vat_amount','total_with_vat'] LOOP
    IF (h->>field_name)::numeric IS DISTINCT FROM (p_commitment#>>ARRAY['commitment_snapshot','amounts',field_name])::numeric
      OR p_expected_history->>field_name IS NULL THEN
      RAISE EXCEPTION 'Recorded amount % differs from recovery evidence', field_name;
    END IF;
  END LOOP;
  FOREACH field_name IN ARRAY ARRAY['term_start_date','term_end_date','membership_renewal_date'] LOOP
    IF h->>field_name IS NOT NULL AND h->>field_name IS DISTINCT FROM p_commitment->>field_name THEN
      RAISE EXCEPTION 'Existing membership dates conflict with recovery evidence';
    END IF;
  END LOOP;
  -- Applying the agreement and history in this same function is atomic. Any
  -- trigger/overlap/uniqueness failure rolls BOTH changes and the audit back.
  SELECT string_agg(format('%I=x.%I',key,key),',') INTO cols
    FROM jsonb_each(rolling_commitment_fields(p_commitment));
  IF a IS NOT NULL AND a->>'term_key' IS NULL THEN
    EXECUTE format('UPDATE membership_billing_agreements SET %s FROM jsonb_populate_record(NULL::membership_billing_agreements,$1) x
      WHERE membership_billing_agreements.id=$2 AND membership_billing_agreements.tenant_id=$3', cols)
      USING rolling_commitment_fields(p_commitment), (a->>'id')::uuid, p_tenant_id;
  END IF;
  IF q IS NOT NULL THEN
    -- Preserve the original legacy quote verbatim; record the verified
    -- canonical interpretation separately for future PI reconciliation.
    UPDATE membership_payment_quote SET recovered_commitment=rolling_commitment_fields(p_commitment)
      WHERE id=(q->>'id')::uuid AND tenant_id=p_tenant_id;
  END IF;
  EXECUTE format('UPDATE %I SET %s FROM jsonb_populate_record(NULL::%I,$1) x
    WHERE %I.id=$2 AND %I.tenant_id=$3 RETURNING to_jsonb(%I.*)', t,cols,t,t,t,t)
    INTO result USING rolling_commitment_fields(p_commitment), p_history_id,p_tenant_id;
  INSERT INTO rolling_membership_recovery_audit(tenant_id,history_type,history_id,evidence_type,evidence_id,original_history,commitment)
    VALUES(p_tenant_id,p_history_type,p_history_id,evidence_type,evidence_id,original_history,rolling_commitment_fields(p_commitment));
  RETURN jsonb_build_object('status','recovered','id',p_history_id,'record',result);
END $$;
REVOKE ALL ON FUNCTION recover_rolling_membership_commitment(UUID,TEXT,UUID,JSONB,JSONB,JSONB,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION recover_rolling_membership_commitment(UUID,TEXT,UUID,JSONB,JSONB,JSONB,JSONB) TO service_role;
COMMIT;