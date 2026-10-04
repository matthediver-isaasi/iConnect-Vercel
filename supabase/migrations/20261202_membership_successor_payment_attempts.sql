BEGIN;
-- A cancelled intent does not erase its immutable quote or successor ownership.
-- Replacement attempts retain both, with a separate immutable provider ledger.
CREATE TABLE public.membership_successor_payment_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  quote_id uuid NOT NULL REFERENCES public.membership_payment_quote(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  previous_intent_id text NOT NULL CHECK (length(previous_intent_id)>0),
  provider_intent_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(quote_id,attempt_number),
  UNIQUE(quote_id,previous_intent_id)
);
ALTER TABLE public.membership_successor_payment_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_successor_payment_attempt FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_successor_payment_attempt TO service_role;

CREATE FUNCTION public.reserve_successor_payment_attempt(
  p_tenant_id uuid,p_quote_id uuid,p_cancelled_intent_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.membership_payment_quote%ROWTYPE;
  a public.membership_successor_payment_attempt%ROWTYPE;
  n integer := 1; expected text;
BEGIN
  SELECT * INTO q FROM public.membership_payment_quote
    WHERE id=p_quote_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.membership_successor_election
    WHERE payment_quote_id=q.id AND tenant_id=p_tenant_id AND status='reserved'
      AND origin='form' AND payment_method='upfront') THEN
    RAISE EXCEPTION 'A reserved successor quote is required';
  END IF;
  IF p_cancelled_intent_id IS NULL OR length(p_cancelled_intent_id)=0 THEN
    RAISE EXCEPTION 'Confirmed cancelled provider identity is required';
  END IF;
  SELECT * INTO a FROM public.membership_successor_payment_attempt
    WHERE quote_id=q.id AND previous_intent_id=p_cancelled_intent_id;
  IF FOUND THEN RETURN to_jsonb(a); END IF;
  expected := q.stripe_payment_intent_id;
  SELECT * INTO a FROM public.membership_successor_payment_attempt
    WHERE quote_id=q.id ORDER BY attempt_number DESC LIMIT 1;
  IF FOUND THEN expected := a.provider_intent_id; n := a.attempt_number+1; END IF;
  IF expected IS NULL OR expected IS DISTINCT FROM p_cancelled_intent_id THEN
    RAISE EXCEPTION 'Provider outcome must be reconciled before another attempt';
  END IF;
  INSERT INTO public.membership_successor_payment_attempt(
    tenant_id,quote_id,attempt_number,previous_intent_id)
    VALUES(p_tenant_id,q.id,n,p_cancelled_intent_id) RETURNING * INTO a;
  RETURN to_jsonb(a);
END $$;
REVOKE ALL ON FUNCTION public.reserve_successor_payment_attempt(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_successor_payment_attempt(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.bind_successor_payment_attempt(
  p_tenant_id uuid,p_quote_id uuid,p_attempt_id uuid,p_intent_id text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.membership_successor_payment_attempt%ROWTYPE;
BEGIN
  IF p_intent_id IS NULL OR length(p_intent_id)=0 THEN RAISE EXCEPTION 'Provider identity is required'; END IF;
  SELECT * INTO a FROM public.membership_successor_payment_attempt
    WHERE id=p_attempt_id AND quote_id=p_quote_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR (a.provider_intent_id IS NOT NULL AND a.provider_intent_id<>p_intent_id) THEN
    RAISE EXCEPTION 'Payment attempt identity mismatch';
  END IF;
  UPDATE public.membership_successor_payment_attempt SET provider_intent_id=p_intent_id WHERE id=a.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.bind_successor_payment_attempt(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bind_successor_payment_attempt(uuid,uuid,uuid,text) TO service_role;
COMMIT;