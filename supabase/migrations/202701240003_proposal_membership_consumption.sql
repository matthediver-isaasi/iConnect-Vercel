BEGIN;
ALTER TABLE public.organisation_membership_history ADD COLUMN proposal_membership jsonb;
CREATE TABLE public.proposal_membership_consumption (
  entitlement_id uuid PRIMARY KEY REFERENCES public.proposal_membership_entitlement(id),
  tenant_id uuid NOT NULL,
  history_id uuid NOT NULL UNIQUE REFERENCES public.organisation_membership_history(id) DEFERRABLE INITIALLY DEFERRED,
  membership_year text NOT NULL,
  original_base_net_minor bigint NOT NULL CHECK(original_base_net_minor>=0),
  original_base_vat_minor bigint NOT NULL CHECK(original_base_vat_minor>=0),
  consumed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,entitlement_id) REFERENCES public.proposal_membership_entitlement(tenant_id,id)
);
ALTER TABLE public.proposal_membership_consumption ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.proposal_membership_consumption FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.proposal_membership_consumption TO service_role;
CREATE TRIGGER proposal_membership_consumption_immutable BEFORE UPDATE OR DELETE
  ON public.proposal_membership_consumption FOR EACH ROW EXECUTE FUNCTION public.guard_proposal_membership_entitlement();

CREATE FUNCTION public.pending_proposal_membership_entitlement(p_tenant uuid,p_organization uuid,p_schedule uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT to_jsonb(e) FROM proposal_membership_entitlement e
  WHERE e.tenant_id=p_tenant AND e.organization_id=p_organization AND e.schedule_id=p_schedule
    AND NOT EXISTS(SELECT 1 FROM proposal_membership_consumption c WHERE c.entitlement_id=e.id)
  ORDER BY e.granted_at,e.id LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.pending_proposal_membership_entitlement(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pending_proposal_membership_entitlement(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.consume_proposal_membership_on_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.proposal_membership_entitlement%ROWTYPE; snapshot jsonb := NEW.proposal_membership;
  net bigint; vat bigint;
BEGIN
  -- Serialise every matching writer, including legacy writers without a marker.
  PERFORM 1 FROM organization WHERE id=NEW.organization_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  SELECT * INTO e FROM proposal_membership_entitlement x
    WHERE x.tenant_id=NEW.tenant_id AND x.organization_id=NEW.organization_id AND x.schedule_id=NEW.config_id
    AND NOT EXISTS(SELECT 1 FROM proposal_membership_consumption c WHERE c.entitlement_id=x.id)
    ORDER BY x.granted_at,x.id LIMIT 1 FOR UPDATE;
  IF e.id IS NULL THEN
    IF snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'Proposal benefit is no longer available; recalculate before creating membership' USING ERRCODE='PT409';
    END IF;
    RETURN NEW;
  END IF;
  IF snapshot IS NULL OR snapshot->>'entitlementId' IS DISTINCT FROM e.id::text
    OR snapshot->>'scheduleId' IS DISTINCT FROM NEW.config_id::text
    OR snapshot->>'quoteId' IS DISTINCT FROM e.quote_id::text
    OR snapshot->>'quoteVersionId' IS DISTINCT FROM e.quote_version_id::text THEN
    RAISE EXCEPTION 'An available proposal benefit must be recalculated before creating this membership' USING ERRCODE='PT409';
  END IF;
  IF jsonb_typeof(snapshot->'originalBaseNetMinor') IS DISTINCT FROM 'number'
    OR jsonb_typeof(snapshot->'originalBaseVatMinor') IS DISTINCT FROM 'number'
    OR NOT (snapshot->>'originalBaseNetMinor' ~ '^[0-9]+$')
    OR NOT (snapshot->>'originalBaseVatMinor' ~ '^[0-9]+$') THEN
    RAISE EXCEPTION 'Original proposal membership fee evidence is invalid' USING ERRCODE='22023';
  END IF;
  net := (snapshot->>'originalBaseNetMinor')::bigint;
  vat := (snapshot->>'originalBaseVatMinor')::bigint;
  IF NEW.billing_agreement_id IS NOT NULL THEN
    RAISE EXCEPTION 'Existing payment agreements cannot be converted to proposal coverage; review before creating membership' USING ERRCODE='PT409';
  END IF;
  INSERT INTO proposal_membership_consumption(entitlement_id,tenant_id,history_id,membership_year,original_base_net_minor,original_base_vat_minor)
    VALUES(e.id,NEW.tenant_id,NEW.id,NEW.membership_year,net,vat);
  IF COALESCE(NEW.total_with_vat,NEW.final_cost)=0 THEN
    -- 'paid' is the legacy access/activation state, not payment evidence.
    -- Keep the receipt timestamp empty and use an explicit non-payment method.
    NEW.payment_status := 'paid';
    NEW.payment_method := 'proposal_entitlement';
    NEW.paid_at := NULL;
    NEW.stripe_payment_intent_id := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proposal_membership_consume BEFORE INSERT ON public.organisation_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.consume_proposal_membership_on_creation();
REVOKE ALL ON FUNCTION public.consume_proposal_membership_on_creation() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.guard_proposal_membership_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.proposal_membership IS DISTINCT FROM NEW.proposal_membership
    OR (OLD.proposal_membership IS NOT NULL AND
      (OLD.tenant_id,OLD.organization_id,OLD.config_id,OLD.membership_year,OLD.final_cost,OLD.total_with_vat,OLD.currency,OLD.vat_amount,OLD.annual_cost)
      IS DISTINCT FROM (NEW.tenant_id,NEW.organization_id,NEW.config_id,NEW.membership_year,NEW.final_cost,NEW.total_with_vat,NEW.currency,NEW.vat_amount,NEW.annual_cost)) THEN
    RAISE EXCEPTION 'Proposal-covered membership amounts and provenance are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.proposal_membership IS NOT NULL AND OLD.payment_method='proposal_entitlement'
    AND (NEW.paid_at IS NOT NULL OR NEW.payment_method IS DISTINCT FROM OLD.payment_method) THEN
    RAISE EXCEPTION 'Complimentary membership is not evidence of payment receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proposal_membership_history_immutable BEFORE UPDATE ON public.organisation_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_proposal_membership_history();
REVOKE ALL ON FUNCTION public.guard_proposal_membership_history() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
