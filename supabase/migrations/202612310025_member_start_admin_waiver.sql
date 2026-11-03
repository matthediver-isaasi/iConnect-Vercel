-- A waiver is purchase evidence, never a structure price or renewal policy.
-- Keep the existing atomic creator, member lock, zero-total and overlap guards.
BEGIN;
CREATE FUNCTION public.validate_member_start_admin_waiver() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE w jsonb := NEW.quote->'adminWaiver'; original jsonb;
BEGIN
  IF NEW.request->>'paymentMode' = 'free' THEN
    original := w->'originalAmounts';
    IF w->>'version' IS DISTINCT FROM '1'
      OR w->>'scope' IS DISTINCT FROM 'purchased_period_only'
      OR w->>'reason' IS DISTINCT FROM NEW.request->>'reason'
      OR NEW.quote->>'paymentMode' IS DISTINCT FROM 'free'
      OR NEW.actor_id IS NULL
      OR (NEW.quote->>'finalCost')::numeric IS DISTINCT FROM 0
      OR (NEW.quote->>'vatAmount')::numeric IS DISTINCT FROM 0
      OR (NEW.quote->>'totalWithVat')::numeric IS DISTINCT FROM 0
      OR original IS DISTINCT FROM NEW.quote->'initialQuotedAmounts'
      OR jsonb_typeof(original->'finalCost') IS DISTINCT FROM 'number'
      OR jsonb_typeof(original->'vatAmount') IS DISTINCT FROM 'number'
      OR jsonb_typeof(original->'totalWithVat') IS DISTINCT FROM 'number'
      OR (original->>'finalCost')::numeric < 0
      OR (original->>'vatAmount')::numeric < 0
      OR (original->>'totalWithVat')::numeric IS DISTINCT FROM
        (original->>'finalCost')::numeric + (original->>'vatAmount')::numeric
      OR NEW.quote->'paymentOffer' IS NOT NULL AND NEW.quote->'paymentOffer' <> 'null'::jsonb
    THEN RAISE EXCEPTION 'Invalid period-only administrative waiver'; END IF;
  ELSIF w IS NOT NULL THEN
    RAISE EXCEPTION 'Administrative waiver requires No charge';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_start_admin_waiver BEFORE INSERT ON public.member_membership_start
FOR EACH ROW EXECUTE FUNCTION public.validate_member_start_admin_waiver();
REVOKE ALL ON FUNCTION public.validate_member_start_admin_waiver() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.member_start_payment_capabilities() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('version',2,'memberChoice',true,'noCharge',true,
    'paymentModes',jsonb_build_array('stripe_upfront','stripe_monthly','direct_debit','member_choice'));
$$;
REVOKE ALL ON FUNCTION public.member_start_payment_capabilities() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_start_payment_capabilities() TO service_role;
COMMIT;
