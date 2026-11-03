-- Deliberately does not enable checkout or alter tenant rollout settings.
BEGIN;
CREATE TABLE IF NOT EXISTS public.membership_post_grace_date_application (
  reservation_id uuid PRIMARY KEY REFERENCES public.membership_post_grace_renewal(id),
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('applying','applied')),
  before_rows jsonb NOT NULL,
  after_rows jsonb NOT NULL,
  applied_at timestamptz,
  CHECK ((state='applied') = (applied_at IS NOT NULL))
);
ALTER TABLE public.membership_post_grace_date_application ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_post_grace_date_application FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_post_grace_date_application TO service_role;

CREATE OR REPLACE FUNCTION public.post_grace_metadata_dates(m jsonb,d jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE result jsonb:=coalesce(m,'{}'::jsonb); k text;
BEGIN
  IF jsonb_typeof(result->'commitment')='object' THEN
    result:=jsonb_set(result,'{commitment}',(result->'commitment')||d);
  END IF;
  FOREACH k IN ARRAY ARRAY['card','dd'] LOOP
    IF jsonb_typeof(result#>ARRAY[k,'commitment'])='object' THEN
      result:=jsonb_set(result,ARRAY[k,'commitment'],(result#>ARRAY[k,'commitment'])||d);
    END IF;
  END LOOP;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.post_grace_metadata_dates(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- No session flag or browser-writable bypass. Only exact before/after images
-- created inside the finalizer transaction can pass an immutable-date guard.
CREATE OR REPLACE FUNCTION public.post_grace_date_write_allowed(t text,old_row jsonb,new_row jsonb)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT pg_trigger_depth()>0 AND EXISTS (
    SELECT FROM public.membership_post_grace_date_application a
    WHERE a.state='applying' AND a.tenant_id::text=old_row->>'tenant_id'
      AND a.member_id::text=old_row->>'member_id'
      AND a.before_rows->CASE t WHEN 'member_membership_history' THEN 'history'
        WHEN 'membership_billing_agreements' THEN 'agreement'
        WHEN 'membership_payment_plans' THEN 'plan' ELSE '' END=old_row
      AND a.after_rows->CASE t WHEN 'member_membership_history' THEN 'history'
        WHEN 'membership_billing_agreements' THEN 'agreement'
        WHEN 'membership_payment_plans' THEN 'plan' ELSE '' END=new_row
  );
$$;
REVOKE ALL ON FUNCTION public.post_grace_date_write_allowed(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- Only usable from a trigger; outside a trigger it always returns false.
GRANT EXECUTE ON FUNCTION public.post_grace_date_write_allowed(text,jsonb,jsonb) TO anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.post_grace_purchase_year(r jsonb)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.before_rows#>>'{history,membership_year}'
  FROM public.membership_post_grace_date_application a
  WHERE pg_trigger_depth()>0 AND a.state='applied'
    AND a.tenant_id::text=r->>'tenant_id' AND a.member_id::text=r->>'member_id'
    AND a.after_rows#>>'{history,id}'=r->>'id'
    AND a.after_rows#>>'{history,term_key}'=r->>'term_key'
$$;
REVOKE ALL ON FUNCTION public.post_grace_purchase_year(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_grace_purchase_year(jsonb) TO anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.apply_post_grace_record_dates(
  p_tenant_id uuid,p_member_id uuid,p_reservation_id uuid,
  p_provider text,p_payment_id text,p_status text,p_paid_at timestamptz,
  p_amount_minor bigint,p_currency text,p_expected jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.membership_post_grace_renewal%ROWTYPE; receipt jsonb;
  h jsonb; a jsonb; p jsonb; nh jsonb; na jsonb; np jsonb; d jsonb;
  original jsonb; replacements jsonb; row_before jsonb; row_after jsonb; election jsonb; quote_row jsonb;
  table_name text; key_name text; columns_sql text; start_day date; end_day date;
BEGIN
  IF p_tenant_id IS NULL OR p_member_id IS NULL OR p_reservation_id IS NULL THEN
    RAISE EXCEPTION 'Post-grace identity is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
  SELECT * INTO r FROM public.membership_post_grace_renewal
    WHERE id=p_reservation_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Post-grace reservation not found'; END IF;
  -- Revalidates exact provider evidence on replay, before returning a receipt.
  PERFORM public.record_post_grace_payment(p_tenant_id,p_member_id,p_reservation_id,
    p_provider,p_payment_id,p_status,p_paid_at,p_amount_minor,p_currency);
  SELECT to_jsonb(x) INTO receipt FROM public.membership_post_grace_date_application x
    WHERE reservation_id=p_reservation_id;
  IF receipt IS NOT NULL THEN
    IF receipt->>'state'<>'applied' OR receipt->'before_rows' IS DISTINCT FROM p_expected THEN
      RAISE EXCEPTION 'Different post-grace finalization already exists';
    END IF;
    RETURN receipt;
  END IF;
  SELECT * INTO r FROM public.membership_post_grace_renewal WHERE id=p_reservation_id;
  SELECT to_jsonb(x) INTO election FROM public.membership_successor_election x
    WHERE id=r.election_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  IF election IS NULL OR election->>'status' IS DISTINCT FROM 'reserved'
    OR election->>'previous_term_id' IS DISTINCT FROM r.previous_term_id::text
    OR election->>'payment_method' IS DISTINCT FROM r.payment_method
    OR coalesce(election->>'switch_state','idle')<>'idle' THEN
    RAISE EXCEPTION 'Post-grace election is no longer available';
  END IF;
  SELECT to_jsonb(x) INTO h FROM public.member_membership_history x
    WHERE id=(p_expected#>>'{history,id}')::uuid AND tenant_id=p_tenant_id
      AND member_id=p_member_id FOR UPDATE;
  IF h IS NULL OR h IS DISTINCT FROM p_expected->'history'
    OR h->>'id'=r.previous_term_id::text
    OR h->>'membership_successor_election_id' IS DISTINCT FROM r.election_id::text
    OR (h->>'previous_term_id' IS NOT NULL AND h->>'previous_term_id' IS DISTINCT FROM r.previous_term_id::text)
    OR h->>'status' IS NULL OR h->>'status' NOT IN ('pending','pending_payment_setup','scheduled')
    OR h->>'payment_status' IS NULL OR h->>'payment_status' NOT IN ('unpaid','pending')
    OR h->>'organization_id' IS NOT NULL
    OR jsonb_typeof(h->'commitment_snapshot') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Pending successor changed or cannot be verified';
  END IF;
  IF r.payment_method<>'upfront' THEN
    SELECT to_jsonb(x) INTO a FROM public.membership_billing_agreements x
      WHERE id=(h->>'billing_agreement_id')::uuid AND tenant_id=p_tenant_id
        AND member_id=p_member_id FOR UPDATE;
    SELECT to_jsonb(x) INTO p FROM public.membership_payment_plans x
      WHERE billing_agreement_id=(a->>'id')::uuid AND tenant_id=p_tenant_id
        AND member_id=p_member_id FOR UPDATE;
    IF a IS NULL OR a IS DISTINCT FROM p_expected->'agreement'
      OR p IS DISTINCT FROM nullif(p_expected->'plan','null'::jsonb)
      OR (p IS NULL AND a->>'payment_plan_id' IS NOT NULL)
      OR a->>'organization_id' IS NOT NULL OR p->>'organization_id' IS NOT NULL
      OR a->>'membership_successor_election_id' IS DISTINCT FROM r.election_id::text
      OR (p IS NOT NULL AND p->>'billing_agreement_id' IS DISTINCT FROM a->>'id')
      OR a->>'provider' IS DISTINCT FROM p_provider
      OR a->>'status' IS NULL OR a->>'status' NOT IN ('payment_setup_required','mandate_pending','first_payment_pending','active')
      OR public.rolling_commitment_fields(a) IS DISTINCT FROM public.rolling_commitment_fields(h) THEN
      RAISE EXCEPTION 'Pending monthly arrangement changed or cannot be verified';
    END IF;
    IF (SELECT count(*) FROM public.membership_payment_plans
      WHERE billing_agreement_id=(a->>'id')::uuid)>1 THEN
      RAISE EXCEPTION 'Monthly arrangement has ambiguous payment plans';
    END IF;
  ELSIF h->>'billing_agreement_id' IS NOT NULL
    OR coalesce(p_expected->'agreement','null'::jsonb)<>'null'::jsonb
    OR coalesce(p_expected->'plan','null'::jsonb)<>'null'::jsonb THEN
    RAISE EXCEPTION 'Upfront renewal cannot change a monthly arrangement';
  END IF;
  start_day:=r.term_start_date; end_day:=r.term_end_date;
  IF EXISTS (SELECT FROM public.member_membership_history x
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND id<>(h->>'id')::uuid
      AND term_start_date<=end_day AND term_end_date>=start_day) THEN
    RAISE EXCEPTION 'Confirmed dates overlap another membership';
  END IF;
  IF EXISTS (SELECT FROM public.membership_billing_agreements x
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id
      AND id IS DISTINCT FROM (a->>'id')::uuid
      AND status NOT IN ('cancelled','canceled','completed','expired')
      AND term_start_date<=end_day AND term_end_date>=start_day) THEN
    RAISE EXCEPTION 'Confirmed dates overlap another payment arrangement';
  END IF;
  d:=jsonb_build_object('term_start_date',start_day,'term_end_date',end_day,
    'membership_renewal_date',end_day+1,'term_duration_months',12,
    'term_anchor_date',start_day,'term_key','rolling:'||start_day,
    'previous_term_id',h->'previous_term_id');
  -- membership_year is also the provider/checkout correlation key. Retain it;
  -- actual service dates live in the canonical term columns.
  nh:=h||d;
  IF a IS NOT NULL THEN
    na:=a||d||jsonb_build_object('metadata',public.post_grace_metadata_dates(a->'metadata',d));
    IF p IS NOT NULL THEN
      np:=p||jsonb_build_object('start_date',start_day,
        'metadata',public.post_grace_metadata_dates(p->'metadata',d));
    END IF;
  END IF;
  original:=jsonb_build_object('history',h,'agreement',a,'plan',p);
  replacements:=jsonb_build_object('history',nh,'agreement',na,'plan',np);
  INSERT INTO public.membership_post_grace_date_application
    (reservation_id,tenant_id,member_id,state,before_rows,after_rows)
    VALUES(r.id,p_tenant_id,p_member_id,'applying',original,replacements);
  IF h->>'membership_payment_quote_id' IS NOT NULL THEN
    SELECT to_jsonb(x) INTO quote_row FROM public.membership_payment_quote x
      WHERE id=(h->>'membership_payment_quote_id')::uuid AND tenant_id=p_tenant_id
        AND member_id=p_member_id AND organization_id IS NULL FOR UPDATE;
    IF quote_row IS NULL
      OR quote_row#>>'{quote,simResult,formRenewalElectionId}' IS DISTINCT FROM r.election_id::text
      OR public.rolling_commitment_fields(coalesce(nullif(quote_row->'recovered_commitment','null'::jsonb),
        quote_row#>'{quote,simResult,commitment}')) IS DISTINCT FROM public.rolling_commitment_fields(h) THEN
      RAISE EXCEPTION 'Post-grace payment quote no longer matches the purchased membership';
    END IF;
    UPDATE public.membership_payment_quote SET recovered_commitment=public.rolling_commitment_fields(nh)
      WHERE id=(quote_row->>'id')::uuid AND tenant_id=p_tenant_id;
  END IF;
  UPDATE public.membership_successor_election SET term_start_date=start_day,term_end_date=end_day
    WHERE id=r.election_id AND tenant_id=p_tenant_id;
  -- The manifest only authorizes these exact date-only transitions; every
  -- exception rolls the payment journal, all rows and the manifest back.
  FOREACH key_name IN ARRAY ARRAY['agreement','history','plan'] LOOP
    row_before:=original->key_name; row_after:=replacements->key_name;
    IF row_before IS NULL OR row_before='null'::jsonb THEN CONTINUE; END IF;
    table_name:=CASE key_name WHEN 'history' THEN 'member_membership_history'
      WHEN 'agreement' THEN 'membership_billing_agreements' ELSE 'membership_payment_plans' END;
    SELECT string_agg(format('%I=x.%I',key,key),',') INTO columns_sql
      FROM jsonb_each(row_after) WHERE value IS DISTINCT FROM row_before->key;
    IF columns_sql IS NOT NULL THEN
      EXECUTE format('UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I,$1) x
        WHERE t.id=$2 AND t.tenant_id=$3',table_name,columns_sql,table_name)
        USING row_after,(row_before->>'id')::uuid,p_tenant_id;
    END IF;
  END LOOP;
  UPDATE public.membership_post_grace_date_application SET state='applied',applied_at=now()
    WHERE reservation_id=r.id RETURNING to_jsonb(membership_post_grace_date_application.*) INTO receipt;
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)
  FROM PUBLIC,anon,authenticated;

-- Serialize late plan creation with date application. A first DD payment can
-- precede plan creation, but a stale creator must not publish old service dates.
CREATE OR REPLACE FUNCTION public.enforce_post_grace_plan_dates() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a jsonb;
BEGIN
  IF NEW.billing_agreement_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    SELECT to_jsonb(x) INTO a FROM public.membership_billing_agreements x
      WHERE id=NEW.billing_agreement_id FOR KEY SHARE;
  ELSE
    SELECT to_jsonb(x) INTO a FROM public.membership_billing_agreements x WHERE id=NEW.billing_agreement_id;
  END IF;
  IF EXISTS (SELECT FROM public.membership_post_grace_renewal r
    JOIN public.membership_post_grace_date_application receipt ON receipt.reservation_id=r.id
    WHERE r.election_id=(a->>'membership_successor_election_id')::uuid AND receipt.state='applied') THEN
    IF NEW.tenant_id::text IS DISTINCT FROM a->>'tenant_id'
      OR NEW.member_id::text IS DISTINCT FROM a->>'member_id'
      OR NEW.start_date IS DISTINCT FROM (a->>'term_start_date')::date THEN
      RAISE EXCEPTION 'Payment plan must use finalized post-grace service dates';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_post_grace_plan_dates() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS post_grace_plan_dates ON public.membership_payment_plans;
CREATE TRIGGER post_grace_plan_dates BEFORE INSERT OR UPDATE OF start_date,billing_agreement_id
  ON public.membership_payment_plans FOR EACH ROW EXECUTE FUNCTION public.enforce_post_grace_plan_dates();

-- A webhook may still be served by an older deployment. Never let it publish
-- paid/active provisional terms before the new atomic date application exists.
CREATE OR REPLACE FUNCTION public.enforce_post_grace_activation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.membership_post_grace_renewal%ROWTYPE;
BEGIN
  IF NEW.membership_successor_election_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('active','scheduled')
    AND NEW.payment_status NOT IN ('paid','partial') THEN RETURN NEW; END IF;
  SELECT * INTO r FROM public.membership_post_grace_renewal
    WHERE election_id=NEW.membership_successor_election_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF r.tenant_id IS DISTINCT FROM NEW.tenant_id OR r.member_id IS DISTINCT FROM NEW.member_id
    OR r.status<>'settled' OR NOT EXISTS (
      SELECT FROM public.membership_post_grace_date_application receipt
      WHERE receipt.reservation_id=r.id AND receipt.state='applied'
        AND receipt.after_rows#>>'{history,id}'=NEW.id::text
        AND receipt.after_rows#>>'{history,term_start_date}'=NEW.term_start_date::text
        AND receipt.after_rows#>>'{history,term_end_date}'=NEW.term_end_date::text
    ) THEN RAISE EXCEPTION 'Restart access and settlement require finalized payment-dated terms'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_post_grace_activation() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS post_grace_activation ON public.member_membership_history;
CREATE TRIGGER post_grace_activation BEFORE INSERT OR UPDATE ON public.member_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.enforce_post_grace_activation();
-- Keep the RPC inaccessible to the application until the checkout,
-- payment-evidence and provider-collection consumers are integrated. Merely
-- installing this migration must not create a new financial entry point.
REVOKE ALL ON FUNCTION public.apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)
  FROM service_role;

-- Retain the existing guard (including later patches). Only a transaction's
-- exact, service-owned transition can bypass immutable-date comparison.
DO $patch$
DECLARE definition text; marker text; replacement text;
BEGIN
  SELECT pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure) INTO definition;
  IF strpos(definition,'post_grace_exact_date_transition_v1')>0 THEN RETURN; END IF;
  marker := $old$  c := CASE WHEN r->>'term_key' IS NOT NULL THEN rolling_commitment_fields(r) ELSE NULL END;$old$;
  replacement := $new$  -- post_grace_exact_date_transition_v1
  IF TG_OP='UPDATE' AND public.post_grace_date_write_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  c := CASE WHEN r->>'term_key' IS NOT NULL THEN rolling_commitment_fields(r) ELSE NULL END;$new$;
  IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Rolling guard changed; post-grace adapter not installed'; END IF;
  definition:=replace(definition,marker,replacement);
  marker := $old$jsonb_build_object('membership_year', c->>'term_key')$old$;
  replacement := $new$jsonb_build_object('membership_year',coalesce(public.post_grace_purchase_year(r),c->>'term_key'))$new$;
  IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Purchase identity guard changed; post-grace adapter not installed'; END IF;
  definition:=replace(definition,marker,replacement);
  EXECUTE definition;
END $patch$;
COMMIT;
