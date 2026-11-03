BEGIN;
ALTER TABLE public.membership_post_grace_renewal
  ADD COLUMN IF NOT EXISTS payment_method_changes jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.post_grace_quote_first_amount(q jsonb,m text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE amount numeric;
BEGIN
  IF m='upfront' THEN amount:=coalesce((q#>>'{simulation,totalWithVat}')::numeric,(q#>>'{simulation,finalCost}')::numeric);
  ELSIF m IN ('monthly_card','direct_debit') THEN
    amount:=CASE WHEN coalesce(q#>>'{simulation,config,pricing_model}','tiered')='flat'
      THEN (q#>>'{simulation,config,dd_monthly_amount}')::numeric
      ELSE (q#>>'{simulation,matchedBand,dd_monthly_amount}')::numeric END;
  END IF;
  IF amount IS NULL OR amount<=0 THEN RAISE EXCEPTION 'Saved first payment amount is unavailable'; END IF;
  RETURN round(amount*100)::bigint;
END $$;
REVOKE ALL ON FUNCTION public.post_grace_quote_first_amount(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

-- The existing provider-verified switch must finish first. This only aligns
-- the still-unpaid journal with that election; it cannot cancel providers or
-- change the election itself, and retains the original selection as audit.
CREATE OR REPLACE FUNCTION public.sync_post_grace_renewal_method(p_tenant_id uuid,p_member_id uuid,p_election_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.membership_successor_election%ROWTYPE; r public.membership_post_grace_renewal%ROWTYPE; amount bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
  SELECT * INTO e FROM public.membership_successor_election
    WHERE id=p_election_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  SELECT * INTO r FROM public.membership_post_grace_renewal
    WHERE election_id=p_election_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  IF e.id IS NULL OR r.id IS NULL OR e.status<>'reserved' OR e.switch_state<>'idle'
    OR e.origin<>'form' OR r.status<>'reserved' THEN RAISE EXCEPTION 'Restart is not ready for payment-method selection'; END IF;
  IF r.payment_method=e.payment_method THEN RETURN to_jsonb(r); END IF;
  IF EXISTS (SELECT FROM public.membership_billing_agreements a WHERE a.membership_successor_election_id=e.id
    AND coalesce(a.status,'') NOT IN ('cancelled','canceled','expired','completed'))
    OR EXISTS (SELECT FROM public.membership_payment_quote q WHERE q.quote#>>'{simResult,formRenewalElectionId}'=e.id::text
      AND q.cancelled_for_switch_at IS NULL)
    OR EXISTS (SELECT FROM public.member_membership_history h WHERE h.membership_successor_election_id=e.id
      AND coalesce(h.status,'')<>'expired_checkout') THEN
    RAISE EXCEPTION 'Previous restart payment must be reconciled and retired first';
  END IF;
  amount:=public.post_grace_quote_first_amount(e.quote,e.payment_method);
  UPDATE public.membership_post_grace_renewal SET
    payment_method=e.payment_method,first_payment_minor=amount,
    payment_method_changes=payment_method_changes||jsonb_build_array(jsonb_build_object(
      'from',r.payment_method,'to',e.payment_method,'old_amount_minor',r.first_payment_minor,
      'new_amount_minor',amount,'changed_at',now()))
    WHERE id=r.id RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.sync_post_grace_renewal_method(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE source text; anchor text:='  IF TG_OP = ''UPDATE'' THEN';
  addition text:=$code$
  -- post_grace_method_switch_v1: only the completed, provider-fenced election
  -- may change an unpaid choice. Every other evidence field remains immutable.
  IF TG_OP='UPDATE' AND OLD.status='reserved' AND NEW.status='reserved'
    AND NEW.payment_method IS DISTINCT FROM OLD.payment_method
    AND (to_jsonb(NEW)-ARRAY['payment_method','first_payment_minor','payment_method_changes'])
      =(to_jsonb(OLD)-ARRAY['payment_method','first_payment_minor','payment_method_changes']) THEN
    SELECT * INTO e FROM public.membership_successor_election WHERE id=OLD.election_id FOR UPDATE;
    IF e.status='reserved' AND e.switch_state='idle' AND e.payment_method=NEW.payment_method
      AND e.tenant_id=OLD.tenant_id AND e.member_id=OLD.member_id
      AND NEW.first_payment_minor=public.post_grace_quote_first_amount(e.quote,e.payment_method)
      AND NEW.payment_method_changes=OLD.payment_method_changes||jsonb_build_array(jsonb_build_object(
        'from',OLD.payment_method,'to',NEW.payment_method,'old_amount_minor',OLD.first_payment_minor,
        'new_amount_minor',NEW.first_payment_minor,'changed_at',now())) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Unverified restart payment-method change';
  END IF;
$code$;
BEGIN
  SELECT pg_get_functiondef('public.guard_post_grace_renewal_journal()'::regprocedure) INTO source;
  IF strpos(source,'post_grace_method_switch_v1')=0 THEN
    IF strpos(source,anchor)=0 THEN RAISE EXCEPTION 'Post-grace journal guard changed; review required'; END IF;
    EXECUTE replace(source,anchor,addition||anchor);
  END IF;
END $patch$;
COMMIT;
