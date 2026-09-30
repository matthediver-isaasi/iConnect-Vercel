-- A pending fee link can already back a captured PaymentIntent. Preserve the
-- original server quote independently of whether its history row exists yet.
ALTER TABLE membership_fee_token ADD COLUMN IF NOT EXISTS stripe_payment_attempted_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION protect_rolling_fee_quote()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.cost_breakdown->'commitment'->>'term_key' IS NOT NULL THEN
    IF OLD.cost_breakdown->'commitment' IS DISTINCT FROM NEW.cost_breakdown->'commitment'
       OR OLD.final_cost IS DISTINCT FROM NEW.final_cost
       OR OLD.currency IS DISTINCT FROM NEW.currency
       OR OLD.membership_year IS DISTINCT FROM NEW.membership_year
       OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.member_id IS DISTINCT FROM NEW.member_id
       OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
       OR OLD.cost_breakdown->'totalWithVat' IS DISTINCT FROM NEW.cost_breakdown->'totalWithVat'
       OR OLD.cost_breakdown->'vatAmount' IS DISTINCT FROM NEW.cost_breakdown->'vatAmount' THEN
      RAISE EXCEPTION 'The quoted rolling membership commitment cannot be changed; issue a reviewed replacement quote';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS rolling_fee_quote_immutable ON membership_fee_token;
CREATE TRIGGER rolling_fee_quote_immutable BEFORE UPDATE ON membership_fee_token
  FOR EACH ROW EXECUTE FUNCTION protect_rolling_fee_quote();