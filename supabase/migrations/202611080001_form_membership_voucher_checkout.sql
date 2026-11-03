BEGIN;

-- Installing the bridge is not a financial rollout. Enable only after the
-- complete form/submission/provider-return matrix passes verification.
CREATE FUNCTION public.form_membership_voucher_checkout_ready() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION public.form_membership_voucher_checkout_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_membership_voucher_checkout_ready() TO service_role;

-- A renewal has one authoritative credit checkout, shared by form revisits.
-- No browser may create, retarget or read this mapping directly.
CREATE TABLE public.form_membership_voucher_checkout (
  election_id uuid NOT NULL REFERENCES public.membership_successor_election(id),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  fee_token_id uuid PRIMARY KEY REFERENCES public.membership_fee_token(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX form_membership_voucher_active_election
  ON public.form_membership_voucher_checkout(election_id) WHERE released_at IS NULL;
ALTER TABLE public.form_membership_voucher_checkout ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_membership_voucher_checkout FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.form_membership_voucher_checkout TO service_role;
CREATE POLICY form_membership_voucher_checkout_service ON public.form_membership_voucher_checkout
  FOR SELECT TO service_role USING (true);

CREATE FUNCTION public.bind_form_membership_voucher_checkout(
  p_tenant_id uuid, p_member_id uuid, p_election_id uuid,
  p_breakdown jsonb, p_token text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  e public.membership_successor_election%ROWTYPE;
  t public.membership_fee_token%ROWTYPE;
  b public.form_membership_voucher_checkout%ROWTYPE;
  sim jsonb; expected_mode text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
  SELECT * INTO e FROM public.membership_successor_election
    WHERE id=p_election_id AND tenant_id=p_tenant_id AND member_id=p_member_id
    AND organization_id IS NULL FOR UPDATE;
  IF NOT FOUND OR e.origin<>'form' OR e.status<>'reserved'
    OR e.quote->>'payerMemberId' IS DISTINCT FROM p_member_id::text
    OR coalesce(to_jsonb(e)->>'switch_state','idle')<>'idle' THEN
    RAISE EXCEPTION 'Renewal reservation is unavailable';
  END IF;
  SELECT * INTO b FROM public.form_membership_voucher_checkout WHERE election_id=e.id AND released_at IS NULL;
  IF FOUND THEN
    SELECT * INTO t FROM public.membership_fee_token WHERE id=b.fee_token_id;
    IF t.status='cancelled' THEN RAISE EXCEPTION 'Credit checkout requires reconciliation before restarting'; END IF;
    RETURN to_jsonb(t);
  END IF;
  sim:=e.quote->'simulation';
  expected_mode:=CASE e.payment_method WHEN 'upfront' THEN 'stripe_upfront'
    WHEN 'monthly_card' THEN 'stripe_monthly' WHEN 'direct_debit' THEN 'direct_debit' END;
  IF sim IS NULL OR sim->>'success' IS DISTINCT FROM 'true'
    OR sim#>>'{formRenewal,state}'='post_grace_renewal'
    OR p_breakdown#>'{formVoucher,simulation}' IS DISTINCT FROM sim
    OR p_breakdown#>>'{formVoucher,electionId}' IS DISTINCT FROM e.id::text
    OR p_breakdown#>>'{formVoucher,paymentMode}' IS DISTINCT FROM expected_mode
    OR p_breakdown#>>'{formVoucher,version}' IS DISTINCT FROM '1'
    OR (sim#>>'{membershipYear,start}')::date IS DISTINCT FROM e.term_start_date
    OR (sim#>>'{membershipYear,end}')::date IS DISTINCT FROM e.term_end_date
    OR nullif(sim#>>'{membershipYear,label}','') IS NULL
    OR (p_breakdown->>'totalWithVat')::numeric IS DISTINCT FROM
      coalesce((sim->>'totalWithVat')::numeric,(sim->>'finalCost')::numeric)
    OR p_token !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'Credit checkout does not match the reserved renewal'; END IF;
  IF e.payment_quote_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.membership_billing_agreements WHERE membership_successor_election_id=e.id
      AND status NOT IN ('cancelled','expired','failed','replaced','payment_plan_cancelled')
  ) THEN RAISE EXCEPTION 'Another payment already owns this renewal'; END IF;
  INSERT INTO public.membership_fee_token(
    token,tenant_id,member_id,membership_year,status,final_cost,currency,tier_label,
    cost_breakdown,recipient_email,expires_at
  ) SELECT p_token,p_tenant_id,p_member_id,sim#>>'{membershipYear,label}','pending',
    (sim->>'finalCost')::numeric,coalesce(sim->>'currency','GBP'),sim->>'tierLabel',
    p_breakdown,m.email,now()+interval '7 days'
    FROM public.member m WHERE m.id=p_member_id AND m.tenant_id=p_tenant_id
    RETURNING * INTO t;
  IF t.id IS NULL THEN RAISE EXCEPTION 'Membership owner unavailable'; END IF;
  INSERT INTO public.form_membership_voucher_checkout(election_id,tenant_id,member_id,fee_token_id)
    VALUES(e.id,p_tenant_id,p_member_id,t.id);
  -- Fence conventional form/card/DD checkouts before offering the credit UI.
  PERFORM public.membership_fee_checkout_guard(p_tenant_id,t.id,'voucher');
  RETURN to_jsonb(t);
END $$;
REVOKE ALL ON FUNCTION public.bind_form_membership_voucher_checkout(uuid,uuid,uuid,jsonb,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bind_form_membership_voucher_checkout(uuid,uuid,uuid,jsonb,text)
  TO service_role;

CREATE FUNCTION public.release_form_membership_voucher_checkout(
  p_tenant_id uuid,p_member_id uuid,p_election_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.form_membership_voucher_checkout%ROWTYPE; t public.membership_fee_token%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
  SELECT * INTO b FROM public.form_membership_voucher_checkout
    WHERE election_id=p_election_id AND tenant_id=p_tenant_id AND member_id=p_member_id
    AND released_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN true; END IF;
  SELECT * INTO t FROM public.membership_fee_token WHERE id=b.fee_token_id FOR UPDATE;
  IF t.status='paid' OR EXISTS (SELECT 1 FROM public.membership_voucher_settlement
    WHERE fee_token_id=t.id AND state<>'released')
    OR EXISTS (SELECT 1 FROM public.membership_billing_agreements
      WHERE membership_successor_election_id=p_election_id
      AND status NOT IN ('cancelled','expired','failed','replaced','payment_plan_cancelled'))
    OR ((t.stripe_payment_intent_id IS NOT NULL OR to_jsonb(t)->>'stripe_payment_attempted_at' IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM public.membership_voucher_settlement
        WHERE fee_token_id=t.id AND state='released'))
  THEN RAISE EXCEPTION 'Cancel the existing payment and release its credit before changing method'; END IF;
  DELETE FROM public.membership_payment_term_claim
    WHERE tenant_id=p_tenant_id AND owner_type='member' AND owner_id=p_member_id
    AND membership_year=t.membership_year AND source_key='fee:'||t.id::text AND rail='voucher';
  DELETE FROM public.membership_fee_checkout_claim WHERE fee_token_id=t.id AND tenant_id=p_tenant_id AND rail='voucher';
  UPDATE public.membership_fee_token SET status='cancelled',updated_at=now() WHERE id=t.id;
  UPDATE public.form_membership_voucher_checkout SET released_at=now() WHERE fee_token_id=t.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.release_form_membership_voucher_checkout(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.release_form_membership_voucher_checkout(uuid,uuid,uuid) TO service_role;
COMMIT;
