-- Monthly post-grace collection is deliberately independent from
-- dd_arrears_policy, which remains the membership-access/escalation policy.
ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS monthly_post_grace_collection_policy TEXT NOT NULL DEFAULT 'stop_collecting';

ALTER TABLE membership_tier_config
  DROP CONSTRAINT IF EXISTS membership_tier_config_monthly_post_grace_collection_policy_check;
ALTER TABLE membership_tier_config
  ADD CONSTRAINT membership_tier_config_monthly_post_grace_collection_policy_check
  CHECK (monthly_post_grace_collection_policy IN ('stop_collecting', 'continue_catch_up'));

ALTER TABLE membership_payment_plans
  ADD COLUMN IF NOT EXISTS collection_stopped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS collection_stop_reason TEXT,
  ADD COLUMN IF NOT EXISTS failed_due_period DATE,
  ADD COLUMN IF NOT EXISTS failed_provider_reference TEXT;

CREATE TABLE IF NOT EXISTS membership_monthly_arrears_period (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES membership_payment_plans(id) ON DELETE CASCADE,
  billing_agreement_id UUID REFERENCES membership_billing_agreements(id) ON DELETE SET NULL,
  due_period DATE NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  failed_payment_reference TEXT,
  accrued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  settlement_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plan_id, due_period)
);
CREATE INDEX IF NOT EXISTS membership_monthly_arrears_period_open_idx
  ON membership_monthly_arrears_period (tenant_id, plan_id, due_period)
  WHERE settled_at IS NULL;
CREATE TABLE IF NOT EXISTS membership_monthly_arrears_settlement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES membership_payment_plans(id) ON DELETE CASCADE,
  settlement_reference TEXT NOT NULL,
  settled_count INTEGER NOT NULL DEFAULT 0,
  settled_amount_minor INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plan_id, settlement_reference)
);
-- One accounting obligation per settled arrears period. This is separate from
-- the provider payment mirror because a catch-up payment can settle many
-- periods and must never be posted as one aggregate instalment.
CREATE TABLE IF NOT EXISTS membership_monthly_arrears_accounting (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES membership_payment_plans(id) ON DELETE CASCADE,
  arrears_period_id UUID NOT NULL REFERENCES membership_monthly_arrears_period(id) ON DELETE CASCADE,
  provider_payment_reference TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  accounting_status TEXT NOT NULL DEFAULT 'pending',
  accounting_invoice_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, arrears_period_id, provider_payment_reference)
);
CREATE TABLE IF NOT EXISTS membership_monthly_collection_intent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES membership_payment_plans(id) ON DELETE CASCADE,
  intent_key TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('stop_collecting','continue_catch_up')),
  status TEXT NOT NULL CHECK (status IN ('creating','created','stopping','stopped','completed','failed','manual_resolution')),
  provider_reference TEXT,
  provider_charge_date DATE,
  period_ids UUID[] NOT NULL DEFAULT '{}',
  arrears_amount_minor INTEGER NOT NULL DEFAULT 0,
  planned_amount_minor INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_outcome TEXT,
  UNIQUE (tenant_id, plan_id, intent_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_monthly_collection_intent_provider_ref_uidx
  ON membership_monthly_collection_intent (provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE OR REPLACE FUNCTION claim_membership_monthly_collection_intent(
  p_tenant_id UUID, p_plan_id UUID, p_intent_key TEXT, p_policy TEXT,
  p_period_ids UUID[], p_arrears_amount_minor INTEGER, p_planned_amount_minor INTEGER,
  p_lease_owner UUID
) RETURNS SETOF membership_monthly_collection_intent
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM 1 FROM membership_payment_plans WHERE id=p_plan_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment plan does not belong to tenant'; END IF;
  INSERT INTO membership_monthly_collection_intent
    (tenant_id,plan_id,intent_key,policy,status,period_ids,arrears_amount_minor,planned_amount_minor,lease_owner,lease_expires_at,attempt_count)
  VALUES (p_tenant_id,p_plan_id,p_intent_key,p_policy,CASE WHEN p_policy='stop_collecting' THEN 'stopping' ELSE 'creating' END,p_period_ids,p_arrears_amount_minor,p_planned_amount_minor,p_lease_owner,now()+interval '5 minutes',1)
  ON CONFLICT (tenant_id,plan_id,intent_key) DO UPDATE SET
    status=CASE WHEN p_policy='stop_collecting' THEN 'stopping' ELSE 'creating' END, lease_owner=p_lease_owner, lease_expires_at=now()+interval '5 minutes',
    attempt_count=membership_monthly_collection_intent.attempt_count+1, last_error=NULL, updated_at=now()
  WHERE membership_monthly_collection_intent.status='failed'
     OR (membership_monthly_collection_intent.status IN ('creating','stopping') AND membership_monthly_collection_intent.lease_expires_at < now());
  RETURN QUERY SELECT * FROM membership_monthly_collection_intent
    WHERE tenant_id=p_tenant_id AND plan_id=p_plan_id AND intent_key=p_intent_key AND lease_owner=p_lease_owner;
END $$;
REVOKE ALL ON FUNCTION claim_membership_monthly_collection_intent(UUID,UUID,TEXT,TEXT,UUID[],INTEGER,INTEGER,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION claim_membership_monthly_collection_intent(UUID,UUID,TEXT,TEXT,UUID[],INTEGER,INTEGER,UUID) TO service_role;
CREATE OR REPLACE FUNCTION record_membership_monthly_collection_provider_ref(
  p_tenant_id UUID, p_plan_id UUID, p_intent_key TEXT, p_lease_owner UUID,
  p_provider_reference TEXT, p_provider_charge_date DATE DEFAULT NULL
) RETURNS SETOF membership_monthly_collection_intent
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_intent membership_monthly_collection_intent%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM membership_monthly_collection_intent
   WHERE tenant_id=p_tenant_id AND plan_id=p_plan_id AND intent_key=p_intent_key
     AND lease_owner=p_lease_owner AND status='creating' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'collection intent lease/key does not match'; END IF;
  UPDATE membership_monthly_collection_intent SET status='created',
    provider_reference=p_provider_reference, provider_charge_date=p_provider_charge_date,
    lease_owner=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=now()
   WHERE id=v_intent.id RETURNING * INTO v_intent;
  UPDATE membership_payment_plans SET metadata=jsonb_set(
    COALESCE(metadata,'{}'::jsonb), '{catch_up_intent}',
    jsonb_build_object('key',p_intent_key,'status','created','provider_reference',p_provider_reference,
      'provider_charge_date',p_provider_charge_date,'arrears_amount_minor',v_intent.arrears_amount_minor,
      'period_ids',v_intent.period_ids), true), updated_at=now()
   WHERE id=p_plan_id AND tenant_id=p_tenant_id
     AND metadata->'catch_up_intent'->>'key'=p_intent_key
     AND metadata->'catch_up_intent'->>'status'='creating';
  RETURN QUERY SELECT v_intent;
END $$;
REVOKE ALL ON FUNCTION record_membership_monthly_collection_provider_ref(UUID,UUID,TEXT,UUID,TEXT,DATE) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION record_membership_monthly_collection_provider_ref(UUID,UUID,TEXT,UUID,TEXT,DATE) TO service_role;
CREATE OR REPLACE FUNCTION recover_membership_monthly_collection_provider_ref(
  p_tenant_id UUID, p_plan_id UUID, p_intent_key TEXT, p_provider_reference TEXT,
  p_provider_charge_date DATE DEFAULT NULL
) RETURNS SETOF membership_monthly_collection_intent
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_intent membership_monthly_collection_intent%ROWTYPE;
BEGIN
  PERFORM 1 FROM membership_payment_plans WHERE id=p_plan_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment plan does not belong to tenant'; END IF;
  SELECT * INTO v_intent FROM membership_monthly_collection_intent
    WHERE tenant_id=p_tenant_id AND plan_id=p_plan_id AND intent_key=p_intent_key
      AND status='creating' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recoverable collection intent not found'; END IF;
  UPDATE membership_monthly_collection_intent SET status='created', provider_reference=p_provider_reference,
    provider_charge_date=p_provider_charge_date, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
    WHERE id=v_intent.id RETURNING * INTO v_intent;
  RETURN QUERY SELECT v_intent;
END $$;
REVOKE ALL ON FUNCTION recover_membership_monthly_collection_provider_ref(UUID,UUID,TEXT,TEXT,DATE) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION recover_membership_monthly_collection_provider_ref(UUID,UUID,TEXT,TEXT,DATE) TO service_role;

-- Atomic period creation makes webhook/cron replay safe. The plan tenancy is
-- checked under lock; callers cannot accrue debt into another tenant's plan.
CREATE OR REPLACE FUNCTION accrue_membership_monthly_arrears_period(
  p_tenant_id UUID, p_plan_id UUID, p_due_period DATE, p_amount_minor INTEGER,
  p_currency TEXT, p_payment_reference TEXT DEFAULT NULL
) RETURNS TABLE (period_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_plan membership_payment_plans%ROWTYPE; v_id UUID;
BEGIN
  SELECT * INTO v_plan FROM membership_payment_plans
  WHERE id = p_plan_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment plan does not belong to tenant'; END IF;
  INSERT INTO membership_monthly_arrears_period
    (tenant_id, plan_id, billing_agreement_id, due_period, amount_minor, currency, failed_payment_reference)
  VALUES (p_tenant_id, p_plan_id, v_plan.billing_agreement_id, p_due_period, p_amount_minor, p_currency, p_payment_reference)
  ON CONFLICT (tenant_id, plan_id, due_period) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM membership_monthly_arrears_period
    WHERE tenant_id=p_tenant_id AND plan_id=p_plan_id AND due_period=p_due_period;
    RETURN QUERY SELECT v_id, false;
  ELSE RETURN QUERY SELECT v_id, true; END IF;
END; $$;

-- Oldest-first allocation is locked and idempotent by settlement reference.
CREATE OR REPLACE FUNCTION settle_membership_monthly_arrears(
  p_tenant_id UUID, p_plan_id UUID, p_amount_minor INTEGER, p_settlement_reference TEXT,
  p_period_ids UUID[] DEFAULT NULL
) RETURNS TABLE (settled_count INTEGER, settled_amount_minor INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_remaining INTEGER := p_amount_minor; v_count INTEGER := 0; v_amount INTEGER := 0; v_prior membership_monthly_arrears_settlement%ROWTYPE;
BEGIN
  PERFORM 1 FROM membership_payment_plans WHERE id=p_plan_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment plan does not belong to tenant'; END IF;
  -- Replay check occurs after the plan lock. Concurrent deliveries serialize,
  -- then every loser observes and returns the winner's immutable allocation.
  SELECT * INTO v_prior FROM membership_monthly_arrears_settlement WHERE tenant_id=p_tenant_id AND plan_id=p_plan_id AND settlement_reference=p_settlement_reference;
  IF FOUND THEN RETURN QUERY SELECT v_prior.settled_count, v_prior.settled_amount_minor; RETURN; END IF;
  FOR r IN SELECT * FROM membership_monthly_arrears_period
    WHERE tenant_id=p_tenant_id AND plan_id=p_plan_id AND settled_at IS NULL
      AND (p_period_ids IS NULL OR id = ANY(p_period_ids))
    ORDER BY due_period, created_at FOR UPDATE
  LOOP
    EXIT WHEN v_remaining < r.amount_minor;
    UPDATE membership_monthly_arrears_period SET settled_at=now(), settlement_reference=p_settlement_reference, updated_at=now()
      WHERE id=r.id AND settled_at IS NULL;
    v_remaining:=v_remaining-r.amount_minor; v_count:=v_count+1; v_amount:=v_amount+r.amount_minor;
  END LOOP;
  INSERT INTO membership_monthly_arrears_settlement (tenant_id,plan_id,settlement_reference,settled_count,settled_amount_minor)
    VALUES (p_tenant_id,p_plan_id,p_settlement_reference,v_count,v_amount);
  RETURN QUERY SELECT v_count, v_amount;
END; $$;

REVOKE ALL ON FUNCTION accrue_membership_monthly_arrears_period(UUID, UUID, DATE, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION settle_membership_monthly_arrears(UUID, UUID, INTEGER, TEXT, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accrue_membership_monthly_arrears_period(UUID, UUID, DATE, INTEGER, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION settle_membership_monthly_arrears(UUID, UUID, INTEGER, TEXT, UUID[]) TO service_role;