-- Service-owned next-term ownership. Never changes a predecessor or mandate.
BEGIN;
-- Installing storage is not permission to expose new financial entry points.
-- Enable only after lifecycle/recovery verification and explicit rollout approval.
CREATE TABLE public.membership_successor_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.membership_successor_rollout(singleton,enabled) VALUES(true,false);
ALTER TABLE public.membership_successor_rollout ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_successor_rollout FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.membership_successor_elections_enabled() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT enabled FROM public.membership_successor_rollout WHERE singleton),false)
$$;
REVOKE ALL ON FUNCTION public.membership_successor_elections_enabled() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_successor_elections_enabled() TO service_role;
CREATE TABLE public.membership_successor_election (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid REFERENCES public.member(id),
  organization_id uuid REFERENCES public.organization(id),
  previous_term_id uuid NOT NULL,
  term_start_date date NOT NULL,
  term_end_date date NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('upfront','direct_debit','monthly_card')),
  origin text NOT NULL CHECK (origin IN ('form','worker')),
  quote jsonb NOT NULL CHECK (jsonb_typeof(quote) = 'object'),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','released')),
  payment_quote_id uuid REFERENCES public.membership_payment_quote(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((member_id IS NULL) <> (organization_id IS NULL)),
  CHECK (term_end_date >= term_start_date)
);
CREATE UNIQUE INDEX membership_successor_member_unique ON public.membership_successor_election
  (tenant_id,member_id,term_start_date) WHERE member_id IS NOT NULL AND status <> 'released';
CREATE UNIQUE INDEX membership_successor_org_unique ON public.membership_successor_election
  (tenant_id,organization_id,term_start_date) WHERE organization_id IS NOT NULL AND status <> 'released';
ALTER TABLE public.membership_successor_election ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_successor_election FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.membership_successor_election TO service_role;

CREATE FUNCTION public.reserve_membership_successor(
  p_tenant_id uuid, p_member_id uuid, p_organization_id uuid, p_previous_term_id uuid,
  p_start date, p_end date, p_payment_method text, p_origin text, p_quote jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prior jsonb; owner jsonb; saved public.membership_successor_election%ROWTYPE;
  owner_id uuid := coalesce(p_organization_id,p_member_id);
  owner_column text := CASE WHEN p_organization_id IS NULL THEN 'member_id' ELSE 'organization_id' END;
  history_table text := CASE WHEN p_organization_id IS NULL THEN 'member_membership_history' ELSE 'organisation_membership_history' END;
  anchor date; opens integer; grace integer; conflict_id uuid; policy jsonb;
BEGIN
  IF NOT public.membership_successor_elections_enabled() THEN
    RAISE EXCEPTION 'Membership successor elections are not enabled';
  END IF;
  IF p_tenant_id IS NULL OR (p_member_id IS NULL) = (p_organization_id IS NULL)
    OR p_previous_term_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end < p_start
    OR p_payment_method NOT IN ('upfront','direct_debit','monthly_card')
    OR p_origin NOT IN ('form','worker') OR jsonb_typeof(p_quote) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid successor reservation';
  END IF;
  -- Same lock as existing rolling quotes/history/agreement guards.
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || p_tenant_id::text || ':' || owner_column || ':' || owner_id::text,0));
  EXECUTE format('SELECT to_jsonb(x) FROM %I x WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
    CASE WHEN p_organization_id IS NULL THEN 'member' ELSE 'organization' END)
    INTO owner USING owner_id,p_tenant_id;
  IF owner IS NULL OR coalesce((owner->>'membership_paused')::boolean,false) THEN
    RAISE EXCEPTION 'Membership owner is unavailable or paused';
  END IF;
  EXECUTE format('SELECT to_jsonb(x) FROM %I x WHERE id=$1 AND tenant_id=$2 AND %I=$3 FOR UPDATE', history_table,owner_column)
    INTO prior USING p_previous_term_id,p_tenant_id,owner_id;
  IF prior IS NULL OR prior->>'term_start_date' IS NULL
    OR (prior->>'term_end_date')::date + 1 IS DISTINCT FROM p_start
    OR prior->>'status' IN ('cancelled','canceled','void','expired_checkout') THEN
    RAISE EXCEPTION 'Successor does not follow a trusted predecessor';
  END IF;
  SELECT * INTO saved FROM public.membership_successor_election e
    WHERE e.tenant_id=p_tenant_id AND e.term_start_date=p_start AND e.status <> 'released'
    AND ((p_member_id IS NOT NULL AND e.member_id=p_member_id) OR (p_organization_id IS NOT NULL AND e.organization_id=p_organization_id));
  IF FOUND THEN
    IF saved.previous_term_id <> p_previous_term_id OR saved.payment_method <> p_payment_method OR saved.origin <> p_origin THEN
      RAISE EXCEPTION 'The successor is already reserved by another payment arrangement';
    END IF;
    RETURN to_jsonb(saved);
  END IF;
  IF p_origin='form' THEN
    policy := coalesce(prior->'renewal_policy_snapshot',prior#>'{commitment_snapshot,config}',prior#>'{incentive_snapshot,config}');
    IF policy->>'renewal_open_days' IS NULL OR policy->>'renewal_grace_days' IS NULL THEN
      RAISE EXCEPTION 'Purchased renewal policy is missing';
    END IF;
    opens := (policy->>'renewal_open_days')::integer;
    grace := (policy->>'renewal_grace_days')::integer;
    anchor := CASE WHEN prior->>'term_key' LIKE 'rolling:%' THEN p_start ELSE (prior->>'term_end_date')::date END;
    IF opens NOT BETWEEN 0 AND 366 OR grace NOT BETWEEN 0 AND 366
      OR (now() AT TIME ZONE 'UTC')::date NOT BETWEEN anchor-opens AND anchor+grace THEN
      RAISE EXCEPTION 'Renewal is outside the purchased policy window';
    END IF;
    IF prior->>'billing_agreement_id' IS NULL AND prior->>'payment_status' IS DISTINCT FROM 'paid' THEN
      RAISE EXCEPTION 'The current upfront term is not settled';
    END IF;
  END IF;
  EXECUTE format('SELECT id FROM %I WHERE tenant_id=$1 AND %I=$2 AND term_start_date=$3
    AND status NOT IN (''cancelled'',''canceled'',''void'',''expired_checkout'') LIMIT 1',history_table,owner_column)
    INTO conflict_id USING p_tenant_id,owner_id,p_start;
  IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'The successor term is already recorded'; END IF;
  EXECUTE format('SELECT id FROM membership_billing_agreements WHERE tenant_id=$1 AND %I=$2
    AND term_start_date=$3 AND status NOT IN (''cancelled'',''expired'',''failed'') LIMIT 1',owner_column)
    INTO conflict_id USING p_tenant_id,owner_id,p_start;
  IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'A provider agreement already reserves the successor'; END IF;
  SELECT q.id INTO conflict_id FROM public.membership_payment_quote q
    WHERE q.tenant_id=p_tenant_id
    AND ((p_organization_id IS NULL AND q.organization_id IS NULL AND q.member_id=p_member_id)
      OR q.organization_id=p_organization_id)
    AND coalesce((q.quote#>>'{simResult,commitment,term_start_date}')::date,
      (q.quote#>>'{simResult,paymentSchedule,term_start_date}')::date,
      (q.quote#>>'{simResult,membershipYear,start}')::date)=p_start LIMIT 1;
  IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'An upfront checkout already reserves the successor'; END IF;
  INSERT INTO public.membership_successor_election(tenant_id,member_id,organization_id,previous_term_id,
    term_start_date,term_end_date,payment_method,origin,quote)
    VALUES(p_tenant_id,p_member_id,p_organization_id,p_previous_term_id,p_start,p_end,p_payment_method,p_origin,p_quote)
    RETURNING * INTO saved;
  RETURN to_jsonb(saved);
END $$;
REVOKE ALL ON FUNCTION public.reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb) TO service_role;

CREATE FUNCTION public.save_elected_form_membership_quote(
  p_election_id uuid, p_tenant_id uuid, p_member_id uuid, p_quote jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE election public.membership_successor_election%ROWTYPE; saved public.membership_payment_quote%ROWTYPE;
BEGIN
  SELECT * INTO election FROM public.membership_successor_election e
    WHERE e.id=p_election_id AND e.tenant_id=p_tenant_id AND e.origin='form'
    AND e.payment_method='upfront' AND e.status='reserved' FOR UPDATE;
  IF NOT FOUND OR election.quote->>'payerMemberId' IS DISTINCT FROM p_member_id::text
    OR p_quote#>>'{simResult,formRenewalElectionId}' IS DISTINCT FROM p_election_id::text THEN
    RAISE EXCEPTION 'Payment quote does not belong to the successor election';
  END IF;
  IF election.payment_quote_id IS NOT NULL THEN
    SELECT * INTO saved FROM public.membership_payment_quote WHERE id=election.payment_quote_id;
    RETURN to_jsonb(saved);
  END IF;
  IF p_quote#>>'{simResult,paymentSchedule,term_start_date}' IS DISTINCT FROM election.term_start_date::text
    OR p_quote#>>'{simResult,paymentSchedule,term_end_date}' IS DISTINCT FROM election.term_end_date::text THEN
    RAISE EXCEPTION 'Payment quote changed the elected term';
  END IF;
  INSERT INTO public.membership_payment_quote(tenant_id,member_id,organization_id,term_key,quote)
    VALUES(p_tenant_id,p_member_id,election.organization_id,
      coalesce(p_quote#>>'{simResult,commitment,term_key}','successor:' || election.term_start_date::text),p_quote)
    RETURNING * INTO saved;
  UPDATE public.membership_successor_election SET payment_quote_id=saved.id WHERE id=p_election_id;
  RETURN to_jsonb(saved);
END $$;
REVOKE ALL ON FUNCTION public.save_elected_form_membership_quote(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_elected_form_membership_quote(uuid,uuid,uuid,jsonb) TO service_role;

ALTER TABLE public.membership_billing_agreements ADD COLUMN membership_successor_election_id uuid
  REFERENCES public.membership_successor_election(id);
ALTER TABLE public.member_membership_history ADD COLUMN membership_successor_election_id uuid
  REFERENCES public.membership_successor_election(id);
ALTER TABLE public.organisation_membership_history ADD COLUMN membership_successor_election_id uuid
  REFERENCES public.membership_successor_election(id);
ALTER TABLE public.member_membership_history ADD COLUMN renewal_policy_snapshot jsonb;
ALTER TABLE public.organisation_membership_history ADD COLUMN renewal_policy_snapshot jsonb;

CREATE FUNCTION public.guard_membership_successor_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r jsonb := to_jsonb(NEW); e public.membership_successor_election%ROWTYPE;
  owner_id uuid; owner_column text; start_date date; attached uuid;
BEGIN
  -- Updates to OLD obligations never consult, replace or complete a successor.
  IF TG_OP='UPDATE' THEN
    IF NEW.membership_successor_election_id IS DISTINCT FROM OLD.membership_successor_election_id THEN
      RAISE EXCEPTION 'Successor election provenance is immutable';
    END IF;
    IF TG_TABLE_NAME <> 'membership_billing_agreements'
      AND to_jsonb(OLD)->'renewal_policy_snapshot' IS DISTINCT FROM r->'renewal_policy_snapshot' THEN
      RAISE EXCEPTION 'Purchased renewal policy is immutable';
    END IF;
    RETURN NEW;
  END IF;
  owner_id := coalesce((r->>'organization_id')::uuid,(r->>'member_id')::uuid);
  owner_column := CASE WHEN r->>'organization_id' IS NULL THEN 'member_id' ELSE 'organization_id' END;
  start_date := coalesce((r->>'term_start_date')::date,
    (r#>>'{metadata,dd,membership_year_start}')::date,(r#>>'{metadata,card,membership_year_start}')::date);
  IF owner_id IS NULL OR start_date IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || (r->>'tenant_id') || ':' || owner_column || ':' || owner_id::text,0));
  SELECT * INTO e FROM public.membership_successor_election x WHERE x.tenant_id=(r->>'tenant_id')::uuid
    AND x.term_start_date=start_date AND x.status='reserved'
    AND ((owner_column='member_id' AND x.member_id=owner_id) OR (owner_column='organization_id' AND x.organization_id=owner_id));
  IF NOT FOUND THEN RETURN NEW; END IF;
  attached := NEW.membership_successor_election_id;
  IF TG_TABLE_NAME <> 'membership_billing_agreements' THEN
    IF r->>'billing_agreement_id' IS NOT NULL THEN
      SELECT a.membership_successor_election_id INTO attached FROM public.membership_billing_agreements a
        WHERE a.id=(r->>'billing_agreement_id')::uuid AND a.tenant_id=e.tenant_id;
    ELSIF (r->>'membership_payment_quote_id')::uuid = e.payment_quote_id THEN
      attached := e.id;
    END IF;
  END IF;
  IF attached IS DISTINCT FROM e.id THEN
    RAISE EXCEPTION 'The successor belongs to another reserved payment arrangement';
  END IF;
  NEW.membership_successor_election_id := e.id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_membership_successor_owner() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_successor_owner BEFORE INSERT OR UPDATE ON public.membership_billing_agreements
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_owner();
CREATE TRIGGER guard_successor_owner BEFORE INSERT OR UPDATE ON public.member_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_owner();
CREATE TRIGGER guard_successor_owner BEFORE INSERT OR UPDATE ON public.organisation_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_owner();

CREATE FUNCTION public.guard_membership_successor_quote() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  owner_id uuid := coalesce(NEW.organization_id,NEW.member_id);
  owner_column text := CASE WHEN NEW.organization_id IS NULL THEN 'member_id' ELSE 'organization_id' END;
  start_date date := coalesce((NEW.quote#>>'{simResult,commitment,term_start_date}')::date,
    (NEW.quote#>>'{simResult,paymentSchedule,term_start_date}')::date,
    (NEW.quote#>>'{simResult,membershipYear,start}')::date);
  election_id uuid;
BEGIN
  IF start_date IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || NEW.tenant_id::text || ':' || owner_column || ':' || owner_id::text,0));
  SELECT e.id INTO election_id FROM public.membership_successor_election e
    WHERE e.tenant_id=NEW.tenant_id AND e.term_start_date=start_date AND e.status='reserved'
    AND ((NEW.organization_id IS NULL AND e.member_id=NEW.member_id) OR e.organization_id=NEW.organization_id);
  IF election_id IS NOT NULL AND NEW.quote#>>'{simResult,formRenewalElectionId}' IS DISTINCT FROM election_id::text THEN
    RAISE EXCEPTION 'An elected successor already owns this payment term';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_membership_successor_quote() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_successor_quote BEFORE INSERT ON public.membership_payment_quote
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_quote();
COMMIT;