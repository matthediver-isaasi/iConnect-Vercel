BEGIN;
CREATE TABLE public.proposal_membership_payment_reservation (
  entitlement_id uuid PRIMARY KEY REFERENCES public.proposal_membership_entitlement(id),
  payment_quote_id uuid NOT NULL UNIQUE REFERENCES public.membership_payment_quote(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.proposal_membership_payment_reservation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.proposal_membership_payment_reservation FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.proposal_membership_payment_reservation TO service_role;
CREATE TRIGGER proposal_membership_reservation_immutable BEFORE UPDATE OR DELETE
  ON public.proposal_membership_payment_reservation FOR EACH ROW EXECUTE FUNCTION public.guard_proposal_membership_entitlement();

CREATE FUNCTION public.reserve_proposal_membership_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE benefit jsonb := NEW.quote#>'{simResult,proposalMembership}'; e proposal_membership_entitlement%ROWTYPE;
BEGIN
  IF NEW.organization_id IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM organization WHERE tenant_id=NEW.tenant_id AND id=NEW.organization_id FOR UPDATE;
  SELECT * INTO e FROM proposal_membership_entitlement x WHERE x.tenant_id=NEW.tenant_id
    AND x.organization_id=NEW.organization_id AND x.schedule_id::text=NEW.quote#>>'{simResult,config,id}'
    AND NOT EXISTS(SELECT 1 FROM proposal_membership_consumption c WHERE c.entitlement_id=x.id)
    ORDER BY x.granted_at,x.id LIMIT 1 FOR UPDATE;
  IF e.id IS NULL AND benefit IS NULL THEN RETURN NEW; END IF;
  IF e.id IS NULL OR benefit->>'entitlementId' IS DISTINCT FROM e.id::text
    OR (NEW.quote#>>'{simResult,finalCost}')::numeric IS DISTINCT FROM 0
    OR (NEW.quote#>>'{simResult,totalWithVat}')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Proposal membership eligibility changed; recalculate before payment' USING ERRCODE='PT409';
  END IF;
  INSERT INTO proposal_membership_payment_reservation(entitlement_id,payment_quote_id) VALUES(e.id,NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER proposal_membership_payment_reserve AFTER INSERT ON public.membership_payment_quote
  FOR EACH ROW EXECUTE FUNCTION public.reserve_proposal_membership_payment();
REVOKE ALL ON FUNCTION public.reserve_proposal_membership_payment() FROM PUBLIC,anon,authenticated,service_role;

-- Reuse the original payment quote (and therefore provider idempotency key)
-- even for fixed-date terms which predate term_key support.
ALTER FUNCTION public.reserve_form_membership_payment_quote(uuid,uuid,uuid,jsonb)
  RENAME TO reserve_form_membership_payment_quote_before_proposal;
REVOKE ALL ON FUNCTION public.reserve_form_membership_payment_quote_before_proposal(uuid,uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.reserve_form_membership_payment_quote(
  p_tenant_id uuid,p_member_id uuid,p_organization_id uuid,p_quote jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved membership_payment_quote%ROWTYPE;
BEGIN
  IF p_organization_id IS NOT NULL THEN
    PERFORM 1 FROM organization WHERE tenant_id=p_tenant_id AND id=p_organization_id FOR UPDATE;
    SELECT q.* INTO saved FROM proposal_membership_payment_reservation r
      JOIN proposal_membership_entitlement e ON e.id=r.entitlement_id
      JOIN membership_payment_quote q ON q.id=r.payment_quote_id
      WHERE e.tenant_id=p_tenant_id AND e.organization_id=p_organization_id
        AND e.id::text=p_quote#>>'{simResult,proposalMembership,entitlementId}';
    IF FOUND THEN
      IF saved.member_id IS DISTINCT FROM p_member_id OR
        saved.quote#>>'{simResult,membershipYear,label}' IS DISTINCT FROM p_quote#>>'{simResult,membershipYear,label}' THEN
        RAISE EXCEPTION 'This proposal benefit is reserved by another membership checkout; resume that checkout' USING ERRCODE='PT409';
      END IF;
      RETURN to_jsonb(saved);
    END IF;
  END IF;
  RETURN reserve_form_membership_payment_quote_before_proposal(p_tenant_id,p_member_id,p_organization_id,p_quote);
END $$;
REVOKE ALL ON FUNCTION public.reserve_form_membership_payment_quote(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_form_membership_payment_quote(uuid,uuid,uuid,jsonb) TO service_role;

DO $patch$
DECLARE definition text; anchor text := 'INSERT INTO proposal_membership_consumption(entitlement_id,tenant_id,history_id,membership_year,original_base_net_minor,original_base_vat_minor)';
BEGIN
  SELECT pg_get_functiondef('public.consume_proposal_membership_on_creation()'::regprocedure) INTO definition;
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Consumption contract changed'; END IF;
  EXECUTE replace(definition,anchor,$replacement$
  IF EXISTS(SELECT 1 FROM proposal_membership_payment_reservation r
    WHERE r.entitlement_id=e.id AND r.payment_quote_id IS DISTINCT FROM NEW.membership_payment_quote_id) THEN
    RAISE EXCEPTION 'This proposal benefit is reserved by a payment checkout; resume that checkout' USING ERRCODE='PT409';
  END IF;
  INSERT INTO proposal_membership_consumption(entitlement_id,tenant_id,history_id,membership_year,original_base_net_minor,original_base_vat_minor)
  $replacement$);
END $patch$;
COMMIT;
