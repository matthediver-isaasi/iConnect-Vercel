-- Prepared only. No historical backfill. Do not install/enable catalogue
-- authoring until all membership/payment writers support atomic consumption.
BEGIN;

CREATE TABLE public.proposal_membership_entitlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  organization_id uuid NOT NULL REFERENCES public.organization(id),
  schedule_id uuid NOT NULL REFERENCES public.membership_tier_config(id),
  quote_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  quote_line_id uuid NOT NULL,
  component_id uuid,
  benefit_snapshot jsonb NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_membership_one_per_quote_schedule UNIQUE(tenant_id,quote_id,schedule_id),
  CONSTRAINT proposal_membership_tenant_identity UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,quote_id) REFERENCES public.sales_quote(tenant_id,id),
  FOREIGN KEY(tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id),
  FOREIGN KEY(tenant_id,quote_line_id) REFERENCES public.sales_quote_line(tenant_id,id)
);
CREATE INDEX proposal_membership_owner_schedule
  ON public.proposal_membership_entitlement(tenant_id,organization_id,schedule_id,granted_at,id);
ALTER TABLE public.proposal_membership_entitlement ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.proposal_membership_entitlement FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.proposal_membership_entitlement TO service_role;

CREATE FUNCTION public.guard_proposal_membership_entitlement() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Accepted proposal membership provenance is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER proposal_membership_entitlement_immutable
  BEFORE UPDATE OR DELETE ON public.proposal_membership_entitlement
  FOR EACH ROW EXECUTE FUNCTION public.guard_proposal_membership_entitlement();
REVOKE ALL ON FUNCTION public.guard_proposal_membership_entitlement() FROM PUBLIC,anon,authenticated,service_role;

-- Both acceptance actors change the same immutable version. Granting here
-- participates in that transaction, independently of invoices and delivery.
-- This is deliberately not a callable "grant" API accepting browser benefits.
CREATE FUNCTION public.grant_accepted_proposal_memberships() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  occurrence record;
  benefit jsonb;
  org uuid;
  schedule uuid;
  seen uuid[] := ARRAY[]::uuid[];
  required_terms jsonb := '{"version":1,"scope":"organization","coverage":"next_new_period","periods":1,"baseFeeOnly":true}';
BEGIN
  IF NEW.status <> 'accepted' OR OLD.status = 'accepted' THEN RETURN NEW; END IF;
  FOR occurrence IN
    SELECT l.id AS line_id,NULL::uuid AS component_id,l.quantity AS line_quantity,
      1::numeric AS component_quantity,l.catalogue_snapshot->'membershipBenefit' AS benefit
    FROM public.sales_quote_line l
    WHERE l.tenant_id=NEW.tenant_id AND l.quote_version_id=NEW.id AND l.catalogue_kind='product'
    UNION ALL
    SELECT l.id,c.id,l.quantity,c.quantity,c.product_snapshot->'membershipBenefit'
    FROM public.sales_quote_line l JOIN public.sales_quote_bundle_component c
      ON c.tenant_id=l.tenant_id AND c.quote_line_id=l.id
    WHERE l.tenant_id=NEW.tenant_id AND l.quote_version_id=NEW.id AND l.catalogue_kind='bundle'
  LOOP
    benefit := occurrence.benefit;
    IF benefit IS NULL OR benefit='null'::jsonb THEN CONTINUE; END IF;
    IF jsonb_typeof(benefit) <> 'object'
      OR (benefit - ARRAY['scheduleId','scheduleName']) IS DISTINCT FROM required_terms
      OR jsonb_typeof(benefit->'scheduleName') IS DISTINCT FROM 'string'
      OR length(btrim(benefit->>'scheduleName'))=0
      OR jsonb_typeof(benefit->'scheduleId') IS DISTINCT FROM 'string'
      OR NOT COALESCE(benefit->>'scheduleId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)
    THEN
      RAISE EXCEPTION 'Included membership benefit is invalid; recreate the proposal line'
        USING ERRCODE='22023';
    END IF;
    IF occurrence.line_quantity IS DISTINCT FROM 1 OR occurrence.component_quantity IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'Membership quantities must be 1; future free periods cannot be stacked'
        USING ERRCODE='22023';
    END IF;
    schedule := (benefit->>'scheduleId')::uuid;
    IF schedule=ANY(seen) THEN
      RAISE EXCEPTION 'Include at most one membership benefit per organisation and schedule'
        USING ERRCODE='22023';
    END IF;
    seen := array_append(seen,schedule);
    IF NOT COALESCE(NEW.organisation_snapshot->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false) THEN
      RAISE EXCEPTION 'Select a valid customer organisation before accepting the proposal' USING ERRCODE='22023';
    END IF;
    org := (NEW.organisation_snapshot->>'id')::uuid;
    PERFORM 1 FROM public.organization o WHERE o.id=org AND o.tenant_id=NEW.tenant_id FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer organisation is unavailable in this tenant' USING ERRCODE='22023';
    END IF;
    PERFORM 1 FROM public.membership_tier_config cfg
      WHERE cfg.id=schedule AND cfg.tenant_id=NEW.tenant_id
      AND COALESCE(cfg.structure_scope_type,'organization')='organization'
      AND cfg.is_active IS DISTINCT FROM false FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Included organisational schedule is unavailable; amend the proposal before accepting'
        USING ERRCODE='22023';
    END IF;
    -- No ON CONFLICT DO NOTHING: a different accepted version is not a retry
    -- and must never silently discard a sold benefit.
    INSERT INTO public.proposal_membership_entitlement(
      tenant_id,organization_id,schedule_id,quote_id,quote_version_id,quote_line_id,component_id,benefit_snapshot
    ) VALUES(NEW.tenant_id,org,schedule,NEW.quote_id,NEW.id,occurrence.line_id,occurrence.component_id,benefit);
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.grant_accepted_proposal_memberships() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER proposal_membership_acceptance_grants
  AFTER UPDATE OF status ON public.sales_quote_version
  FOR EACH ROW EXECUTE FUNCTION public.grant_accepted_proposal_memberships();

COMMIT;
