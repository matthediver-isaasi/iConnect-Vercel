-- Persist the authoritative quote before exposing a chargeable PaymentIntent.
-- The PI contains only this opaque id; confirmation and reconciliation load
-- identical prices and dates even if pricing changes while Checkout is open.
CREATE TABLE IF NOT EXISTS membership_payment_quote (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organization(id) ON DELETE CASCADE,
  term_key TEXT,
  stripe_payment_intent_id TEXT,
  quote JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE membership_payment_quote ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE membership_payment_quote FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE membership_payment_quote TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS membership_payment_quote_member_term_uniq
  ON membership_payment_quote (tenant_id, member_id, term_key)
  WHERE organization_id IS NULL AND term_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS membership_payment_quote_org_term_uniq
  ON membership_payment_quote (tenant_id, organization_id, term_key)
  WHERE organization_id IS NOT NULL AND term_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS membership_payment_quote_pi_uniq
  ON membership_payment_quote (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reserve_form_membership_payment_quote(
  p_tenant_id UUID, p_member_id UUID, p_organization_id UUID, p_quote JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  saved membership_payment_quote%ROWTYPE;
  term TEXT := p_quote#>>'{simResult,commitment,term_key}';
  owner_column TEXT := CASE WHEN p_organization_id IS NULL THEN 'member_id' ELSE 'organization_id' END;
  owner_id UUID := COALESCE(p_organization_id, p_member_id);
  conflict_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM member WHERE id=p_member_id AND tenant_id=p_tenant_id)
    OR (p_organization_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM organization WHERE id=p_organization_id AND tenant_id=p_tenant_id)) THEN
    RAISE EXCEPTION 'Membership quote owner does not belong to tenant';
  END IF;
  IF term IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || p_tenant_id::text || ':' || owner_column || ':' || owner_id::text, 0));
    SELECT * INTO saved FROM membership_payment_quote
      WHERE tenant_id=p_tenant_id AND term_key=term
        AND ((p_organization_id IS NULL AND organization_id IS NULL AND member_id=p_member_id)
          OR organization_id=p_organization_id);
    IF FOUND THEN
      IF saved.member_id IS DISTINCT FROM p_member_id THEN
        RAISE EXCEPTION 'Another payer has already reserved this organisation term';
      END IF;
      RETURN to_jsonb(saved);
    END IF;
    -- Dynamic SQL keeps this migration valid before rolling history columns
    -- are added by the immediately following migration.
    EXECUTE format('SELECT id FROM %I WHERE tenant_id=$1 AND %I=$2 AND
      term_start_date < $4 AND membership_renewal_date > $3 LIMIT 1',
      CASE WHEN p_organization_id IS NULL THEN 'member_membership_history' ELSE 'organisation_membership_history' END,
      owner_column)
      INTO conflict_id USING p_tenant_id, owner_id,
        (p_quote#>>'{simResult,commitment,term_start_date}')::date,
        (p_quote#>>'{simResult,commitment,membership_renewal_date}')::date;
    IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'Membership term already recorded'; END IF;
    EXECUTE format('SELECT id FROM membership_billing_agreements WHERE tenant_id=$1 AND %I=$2
      AND status NOT IN (''cancelled'',''expired'',''failed'')
      AND term_start_date < $4 AND membership_renewal_date > $3 LIMIT 1', owner_column)
      INTO conflict_id USING p_tenant_id, owner_id,
        (p_quote#>>'{simResult,commitment,term_start_date}')::date,
        (p_quote#>>'{simResult,commitment,membership_renewal_date}')::date;
    IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'A monthly payment agreement already reserves this membership term'; END IF;
    -- Do not permit a new quote tomorrow to bypass today's pending quote.
    SELECT id INTO conflict_id FROM membership_payment_quote
      WHERE tenant_id=p_tenant_id AND term_key IS NOT NULL
        AND ((p_organization_id IS NULL AND organization_id IS NULL AND member_id=p_member_id)
          OR organization_id=p_organization_id)
        AND (quote#>>'{simResult,commitment,term_start_date}')::date < (p_quote#>>'{simResult,commitment,membership_renewal_date}')::date
        AND (quote#>>'{simResult,commitment,membership_renewal_date}')::date > (p_quote#>>'{simResult,commitment,term_start_date}')::date;
    IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'An upfront payment already reserves an overlapping membership term'; END IF;
  END IF;
  INSERT INTO membership_payment_quote(tenant_id,member_id,organization_id,term_key,quote)
    VALUES(p_tenant_id,p_member_id,p_organization_id,term,p_quote) RETURNING * INTO saved;
  RETURN to_jsonb(saved);
END;
$$;

CREATE OR REPLACE FUNCTION bind_form_membership_payment_quote(
  p_quote_id UUID, p_tenant_id UUID, p_payment_intent_id TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE membership_payment_quote SET stripe_payment_intent_id=p_payment_intent_id
    WHERE id=p_quote_id AND tenant_id=p_tenant_id
      AND (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id=p_payment_intent_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote is already bound to another PaymentIntent'; END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION reserve_form_membership_payment_quote(UUID,UUID,UUID,JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION bind_form_membership_payment_quote(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_form_membership_payment_quote(UUID,UUID,UUID,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION bind_form_membership_payment_quote(UUID,UUID,TEXT) TO service_role;