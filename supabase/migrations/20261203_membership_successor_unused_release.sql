BEGIN;
-- Only a reservation with NO payment quote, agreement or history may expire.
-- Every financial path persists one of those children before provider effects.
CREATE FUNCTION public.release_unused_membership_successor(
  p_tenant_id uuid,p_election_id uuid,p_payer_member_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.membership_successor_election%ROWTYPE; owner_column text;
BEGIN
  SELECT * INTO e FROM public.membership_successor_election
    WHERE id=p_election_id AND tenant_id=p_tenant_id AND origin='form';
  IF NOT FOUND OR e.quote->>'payerMemberId' IS DISTINCT FROM p_payer_member_id::text THEN
    RAISE EXCEPTION 'Reservation is not owned by this payer';
  END IF;
  owner_column := CASE WHEN e.organization_id IS NULL THEN 'member_id' ELSE 'organization_id' END;
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || e.tenant_id::text || ':' ||
    owner_column || ':' || coalesce(e.organization_id,e.member_id)::text,0));
  SELECT * INTO e FROM public.membership_successor_election WHERE id=p_election_id FOR UPDATE;
  IF e.status='released' THEN RETURN true; END IF;
  IF e.created_at > now()-interval '30 minutes' THEN RETURN false; END IF;
  IF e.payment_quote_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.membership_payment_quote WHERE quote#>>'{simResult,formRenewalElectionId}'=e.id::text)
    OR EXISTS(SELECT 1 FROM public.membership_billing_agreements WHERE membership_successor_election_id=e.id)
    OR EXISTS(SELECT 1 FROM public.member_membership_history WHERE membership_successor_election_id=e.id)
    OR EXISTS(SELECT 1 FROM public.organisation_membership_history WHERE membership_successor_election_id=e.id)
    THEN RETURN false;
  END IF;
  UPDATE public.membership_successor_election SET status='released' WHERE id=e.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.release_unused_membership_successor(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.release_unused_membership_successor(uuid,uuid,uuid) TO service_role;

-- Fence delayed creators holding an election that has since been released.
CREATE FUNCTION public.guard_membership_successor_release() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb:=to_jsonb(NEW); eid uuid; e public.membership_successor_election%ROWTYPE;
  owner_column text; owner_id uuid;
BEGIN
  eid := CASE WHEN TG_TABLE_NAME='membership_payment_quote'
    THEN (r#>>'{quote,simResult,formRenewalElectionId}')::uuid
    ELSE (r->>'membership_successor_election_id')::uuid END;
  IF eid IS NULL THEN RETURN NEW; END IF;
  owner_id:=coalesce((r->>'organization_id')::uuid,(r->>'member_id')::uuid);
  owner_column:=CASE WHEN r->>'organization_id' IS NULL THEN 'member_id' ELSE 'organization_id' END;
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || (r->>'tenant_id') || ':' ||
    owner_column || ':' || owner_id::text,0));
  SELECT * INTO e FROM public.membership_successor_election WHERE id=eid FOR UPDATE;
  IF NOT FOUND OR e.status<>'reserved' OR e.tenant_id IS DISTINCT FROM (r->>'tenant_id')::uuid
    OR coalesce(e.organization_id,e.member_id) IS DISTINCT FROM owner_id THEN
    RAISE EXCEPTION 'Successor reservation is released or does not match this owner';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_membership_successor_release() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_successor_release BEFORE INSERT ON public.membership_payment_quote
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_release();
CREATE TRIGGER guard_successor_release BEFORE INSERT ON public.membership_billing_agreements
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_release();
CREATE TRIGGER guard_successor_release BEFORE INSERT ON public.member_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_release();
CREATE TRIGGER guard_successor_release BEFORE INSERT ON public.organisation_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_release();
COMMIT;