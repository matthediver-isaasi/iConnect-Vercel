BEGIN;
CREATE TABLE public.form_joining_voucher_checkout (
  fee_token_id uuid PRIMARY KEY REFERENCES public.membership_fee_token(id),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  breakdown jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX form_joining_voucher_owner ON public.form_joining_voucher_checkout(tenant_id,member_id)
  WHERE released_at IS NULL;
ALTER TABLE public.form_joining_voucher_checkout ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_joining_voucher_checkout FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.form_joining_voucher_checkout TO service_role;
CREATE POLICY form_joining_voucher_service ON public.form_joining_voucher_checkout FOR SELECT TO service_role USING(true);

CREATE FUNCTION public.bind_form_joining_voucher_checkout(p_tenant_id uuid,p_member_id uuid,p_breakdown jsonb,p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.form_joining_voucher_checkout%ROWTYPE; t public.membership_fee_token%ROWTYPE;
  sim jsonb := p_breakdown#>'{formJoiningVoucher,simulation}'; marker jsonb := p_breakdown->'formJoiningVoucher';
  mode text := marker->>'paymentMode';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
  IF NOT EXISTS(SELECT 1 FROM public.member m WHERE m.id=p_member_id AND m.tenant_id=p_tenant_id
    AND coalesce(to_jsonb(m)->>'membership_paused','false')='false') THEN
    RAISE EXCEPTION 'Membership owner unavailable or paused';
  END IF;
  IF sim->>'success' IS DISTINCT FROM 'true' OR marker->>'version' IS DISTINCT FROM '1'
    OR mode IS NULL OR mode NOT IN ('stripe_upfront','stripe_monthly','direct_debit')
    OR p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$'
    OR nullif(sim#>>'{membershipYear,label}','') IS NULL
    OR nullif(sim#>>'{membershipYear,start}','') IS NULL OR nullif(sim#>>'{membershipYear,end}','') IS NULL
    OR (sim#>>'{membershipYear,start}')::date > (sim#>>'{membershipYear,end}')::date
    OR sim#>>'{config,structure_scope_type}' IS DISTINCT FROM 'member'
    OR sim->'previousTerm' IS NOT NULL AND sim->'previousTerm'<>'null'::jsonb
    OR sim->>'formRenewalElectionId' IS NOT NULL
    OR (p_breakdown->>'totalWithVat')::numeric IS DISTINCT FROM coalesce((sim->>'totalWithVat')::numeric,(sim->>'finalCost')::numeric)
    OR coalesce((sim->>'finalCost')::numeric,-1)<0 THEN
    RAISE EXCEPTION 'Invalid first-membership credit quote';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.form f,LATERAL jsonb_array_elements(f.fields) field
    WHERE f.id::text=marker->>'formId' AND f.tenant_id=p_tenant_id
      AND f.is_active AND f.require_authentication
      AND field->>'id'=marker->>'paymentFieldId' AND field->>'type'='membership_payment') THEN
    RAISE EXCEPTION 'Membership form unavailable';
  END IF;
  SELECT * INTO b FROM public.form_joining_voucher_checkout
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND released_at IS NULL;
  IF FOUND THEN
    IF b.breakdown#>>'{formJoiningVoucher,formId}' IS DISTINCT FROM marker->>'formId'
      OR b.breakdown#>>'{formJoiningVoucher,paymentFieldId}' IS DISTINCT FROM marker->>'paymentFieldId'
      OR b.breakdown#>>'{formJoiningVoucher,paymentMode}' IS DISTINCT FROM mode THEN
      RAISE EXCEPTION 'Continue the original first-membership checkout before changing payment method';
    END IF;
    SELECT * INTO t FROM public.membership_fee_token WHERE id=b.fee_token_id;
    IF t.status NOT IN ('pending','paid') THEN RAISE EXCEPTION 'Original checkout requires review'; END IF;
    RETURN to_jsonb(t);
  END IF;
  IF EXISTS(SELECT 1 FROM public.member_membership_history WHERE tenant_id=p_tenant_id AND member_id=p_member_id
      AND coalesce(status,'') NOT IN ('cancelled','canceled','void','expired_checkout'))
    OR EXISTS(SELECT 1 FROM public.membership_billing_agreements WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND organization_id IS NULL
      AND coalesce(status,'') NOT IN ('cancelled','canceled','void','expired_checkout','expired','completed'))
    OR EXISTS(SELECT 1 FROM public.membership_payment_quote q WHERE tenant_id=p_tenant_id AND member_id=p_member_id
      AND to_jsonb(q)->>'organization_id' IS NULL)
    OR EXISTS(SELECT 1 FROM public.membership_payment_term_claim WHERE tenant_id=p_tenant_id AND owner_type='member' AND owner_id=p_member_id)
    THEN RAISE EXCEPTION 'Existing membership payment must be reconciled before starting first-membership credit'; END IF;
  INSERT INTO public.membership_fee_token(token,tenant_id,member_id,membership_year,status,final_cost,currency,tier_label,
    cost_breakdown,recipient_email,expires_at)
    SELECT p_token,p_tenant_id,p_member_id,sim#>>'{membershipYear,label}','pending',(sim->>'finalCost')::numeric,
      coalesce(sim->>'currency','GBP'),sim->>'tierLabel',p_breakdown,m.email,now()+interval '7 days'
    FROM public.member m WHERE m.id=p_member_id AND m.tenant_id=p_tenant_id RETURNING * INTO t;
  INSERT INTO public.form_joining_voucher_checkout(fee_token_id,tenant_id,member_id,breakdown)
    VALUES(t.id,p_tenant_id,p_member_id,p_breakdown);
  PERFORM public.membership_fee_checkout_guard(p_tenant_id,t.id,'voucher');
  RETURN to_jsonb(t);
END $$;
REVOKE ALL ON FUNCTION public.bind_form_joining_voucher_checkout(uuid,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bind_form_joining_voucher_checkout(uuid,uuid,jsonb,text) TO service_role;

-- Serialize conventional form/card/DD starts against the first-purchase
-- reservation, including requests that raced before its publication.
CREATE FUNCTION public.guard_form_joining_voucher_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.form_joining_voucher_checkout%ROWTYPE; settlement text;
BEGIN
  IF NEW.member_id IS NULL OR to_jsonb(NEW)->>'organization_id' IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||NEW.tenant_id::text||':member_id:'||NEW.member_id::text,0));
  SELECT * INTO b FROM public.form_joining_voucher_checkout
    WHERE tenant_id=NEW.tenant_id AND member_id=NEW.member_id AND released_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='membership_billing_agreements' THEN
    settlement:=coalesce(to_jsonb(NEW)#>>'{metadata,dd,voucher_funding,settlement_id}',
      to_jsonb(NEW)#>>'{metadata,card,voucher_funding,settlement_id}');
    IF EXISTS(SELECT 1 FROM public.membership_voucher_settlement s WHERE s.id::text=settlement
      AND s.fee_token_id=b.fee_token_id AND s.tenant_id=b.tenant_id AND s.state<>'released') THEN RETURN NEW; END IF;
  END IF;
  -- A completed first term must not prevent a genuinely later renewal.
  IF EXISTS(SELECT 1 FROM public.membership_fee_token t JOIN public.member_membership_history h ON h.id=t.history_record_id
    WHERE t.id=b.fee_token_id AND t.status='paid' AND h.tenant_id=b.tenant_id AND h.member_id=b.member_id
      AND (CASE WHEN TG_TABLE_NAME='membership_payment_quote'
        THEN to_jsonb(NEW)#>>'{quote,simResult,membershipYear,start}'
        ELSE coalesce(to_jsonb(NEW)#>>'{metadata,dd,commitment,term_start_date}',
          to_jsonb(NEW)#>>'{metadata,card,commitment,term_start_date}') END)::date > h.term_end_date)
    THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Complete or reconcile the existing first-membership credit checkout before starting another payment';
END $$;
REVOKE ALL ON FUNCTION public.guard_form_joining_voucher_payment() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_form_joining_voucher_quote BEFORE INSERT ON public.membership_payment_quote
  FOR EACH ROW EXECUTE FUNCTION public.guard_form_joining_voucher_payment();
CREATE TRIGGER guard_form_joining_voucher_agreement BEFORE INSERT ON public.membership_billing_agreements
  FOR EACH ROW EXECUTE FUNCTION public.guard_form_joining_voucher_payment();
CREATE FUNCTION public.release_form_joining_voucher_checkout(p_tenant_id uuid,p_member_id uuid,p_form_id text,p_field_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.form_joining_voucher_checkout%ROWTYPE; t public.membership_fee_token%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
  SELECT * INTO b FROM public.form_joining_voucher_checkout
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND released_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN true; END IF;
  IF b.breakdown#>>'{formJoiningVoucher,formId}' IS DISTINCT FROM p_form_id
    OR b.breakdown#>>'{formJoiningVoucher,paymentFieldId}' IS DISTINCT FROM p_field_id THEN
    RAISE EXCEPTION 'Continue in the original membership form';
  END IF;
  SELECT * INTO t FROM public.membership_fee_token WHERE id=b.fee_token_id FOR UPDATE;
  IF t.status='paid' OR t.history_record_id IS NOT NULL OR EXISTS(
    SELECT 1 FROM public.membership_voucher_settlement s WHERE s.fee_token_id=t.id AND s.state<>'released')
    OR ((to_jsonb(t)->>'stripe_payment_intent_id' IS NOT NULL OR to_jsonb(t)->>'stripe_payment_attempted_at' IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM public.membership_voucher_settlement WHERE fee_token_id=t.id AND state='released'))
    OR EXISTS(SELECT 1 FROM public.membership_billing_agreements a JOIN public.membership_voucher_settlement s
      ON s.id::text=coalesce(a.metadata#>>'{dd,voucher_funding,settlement_id}',a.metadata#>>'{card,voucher_funding,settlement_id}')
      WHERE s.fee_token_id=t.id AND coalesce(a.status,'') NOT IN ('cancelled','expired','failed','replaced','payment_plan_cancelled'))
    THEN RAISE EXCEPTION 'Reconcile the existing payment and release its credit before changing payment method'; END IF;
  DELETE FROM public.membership_payment_term_claim WHERE tenant_id=p_tenant_id AND owner_type='member'
    AND owner_id=p_member_id AND source_key='fee:'||t.id::text AND rail='voucher';
  DELETE FROM public.membership_fee_checkout_claim WHERE fee_token_id=t.id AND tenant_id=p_tenant_id AND rail='voucher';
  UPDATE public.membership_fee_token SET status='cancelled' WHERE id=t.id;
  UPDATE public.form_joining_voucher_checkout SET released_at=now() WHERE fee_token_id=t.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.release_form_joining_voucher_checkout(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.release_form_joining_voucher_checkout(uuid,uuid,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
