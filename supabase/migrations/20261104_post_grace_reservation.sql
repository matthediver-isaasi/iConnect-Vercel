BEGIN;
CREATE OR REPLACE FUNCTION public.reserve_post_grace_renewal(
  p_tenant_id uuid,p_member_id uuid,p_previous_term_id uuid,p_config_id uuid,
  p_method text,p_first_payment_minor bigint,p_currency text,p_quote jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner jsonb; prior jsonb; config jsonb; policy jsonb; grace integer;
  start_day date:=(now() AT TIME ZONE 'UTC')::date; end_day date; grace_end date;
  e public.membership_successor_election%ROWTYPE; r public.membership_post_grace_renewal%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_member_id IS NULL OR p_previous_term_id IS NULL OR p_config_id IS NULL
    OR p_method IS NULL OR p_method NOT IN ('upfront','monthly_card','direct_debit')
    OR p_first_payment_minor IS NULL OR p_first_payment_minor<0
    OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$'
    OR jsonb_typeof(p_quote) IS DISTINCT FROM 'object'
    OR p_quote->>'payerMemberId' IS DISTINCT FROM p_member_id::text
    OR p_quote#>>'{simulation,config,id}' IS DISTINCT FROM p_config_id::text
    OR p_quote#>>'{simulation,formRenewal,commencementBasis}' IS DISTINCT FROM 'confirmed_payment'
    OR p_quote#>>'{simulation,formRenewal,predecessorId}' IS DISTINCT FROM p_previous_term_id::text THEN
    RAISE EXCEPTION 'Invalid payment-dated renewal reservation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
  PERFORM 1 FROM public.membership_post_grace_policy WHERE tenant_id=p_tenant_id AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Post-grace renewal is not enabled'; END IF;
  SELECT to_jsonb(x) INTO owner FROM public.member x WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
  SELECT to_jsonb(x) INTO prior FROM public.member_membership_history x
    WHERE id=p_previous_term_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  SELECT to_jsonb(x) INTO config FROM public.membership_tier_config x
    WHERE id=p_config_id AND tenant_id=p_tenant_id FOR SHARE;
  IF owner IS NULL OR coalesce((owner->>'membership_paused')::boolean,false)
    OR coalesce((owner->>'membership_cancelled')::boolean,false)
    OR prior IS NULL OR prior->>'payment_status' IS DISTINCT FROM 'paid'
    OR prior->>'billing_agreement_id' IS NOT NULL OR prior->>'organization_id' IS NOT NULL
    OR prior->>'term_start_date' IS NULL OR prior->>'term_end_date' IS NULL
    OR config IS NULL OR config->>'structure_scope_type' IS DISTINCT FROM 'member'
    OR config->>'billing_period' IS DISTINCT FROM 'annual'
    OR config->>'start_mode' IS DISTINCT FROM 'immediate'
    OR config->>'is_active'='false'
    OR (config->>'effective_from')::date>start_day OR (config->>'effective_to')::date<start_day THEN
    RAISE EXCEPTION 'Post-grace owner, prior settlement or selected schedule requires review';
  END IF;
  policy:=coalesce(nullif(prior->'renewal_policy_snapshot','null'::jsonb),
    nullif(prior#>'{commitment_snapshot,config}','null'::jsonb),
    nullif(prior#>'{incentive_snapshot,config}','null'::jsonb));
  IF policy->>'renewal_grace_days' IS NULL OR policy->>'renewal_grace_days' !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Saved grace policy is unavailable';
  END IF;
  grace:=(policy->>'renewal_grace_days')::integer;
  grace_end:=(prior->>'term_end_date')::date+grace+CASE WHEN prior->>'term_key' LIKE 'rolling:%' THEN 1 ELSE 0 END;
  IF grace NOT BETWEEN 0 AND 366 OR start_day<=grace_end THEN RAISE EXCEPTION 'Membership is not after grace'; END IF;
  SELECT * INTO r FROM public.membership_post_grace_renewal
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND previous_term_id=p_previous_term_id AND status<>'released';
  IF FOUND THEN
    IF r.status<>'reserved' OR r.config_id<>p_config_id OR r.payment_method<>p_method
      OR r.first_payment_minor<>p_first_payment_minor OR r.currency<>p_currency THEN
      RAISE EXCEPTION 'Another restart payment is already reserved';
    END IF;
    SELECT * INTO e FROM public.membership_successor_election WHERE id=r.election_id;
    IF e.status<>'reserved' OR e.quote IS DISTINCT FROM p_quote THEN
      RAISE EXCEPTION 'Restart quote changed; continue the original payment';
    END IF;
    RETURN to_jsonb(e);
  END IF;
  IF EXISTS (SELECT FROM public.member_membership_history x
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND id<>p_previous_term_id
      AND coalesce(status,'') NOT IN ('cancelled','canceled','void','expired_checkout','replaced','cancelled_by_request')
      AND (term_end_date IS NULL OR term_end_date>=(prior->>'term_start_date')::date))
    OR EXISTS (SELECT FROM public.membership_billing_agreements
      WHERE tenant_id=p_tenant_id AND member_id=p_member_id
        AND (status IS NULL OR status NOT IN ('cancelled','canceled','completed','expired')))
    OR EXISTS (SELECT FROM public.membership_successor_election x
      WHERE x.tenant_id=p_tenant_id AND x.member_id=p_member_id AND x.status<>'released'
      AND NOT EXISTS (SELECT FROM public.member_membership_history h
        WHERE h.tenant_id=p_tenant_id AND h.member_id=p_member_id
          AND h.membership_successor_election_id=x.id AND h.payment_status='paid')) THEN
    RAISE EXCEPTION 'Another membership or payment arrangement requires review';
  END IF;
  end_day:=(start_day+interval '1 year')::date-1;
  IF p_quote#>>'{simulation,paymentSchedule,term_start_date}' IS DISTINCT FROM start_day::text
    OR p_quote#>>'{simulation,paymentSchedule,term_end_date}' IS DISTINCT FROM end_day::text THEN
    RAISE EXCEPTION 'Restart quote no longer describes the current provisional year';
  END IF;
  INSERT INTO public.membership_successor_election
    (tenant_id,member_id,previous_term_id,term_start_date,term_end_date,payment_method,origin,quote)
    VALUES(p_tenant_id,p_member_id,p_previous_term_id,start_day,end_day,p_method,'form',p_quote)
    RETURNING * INTO e;
  INSERT INTO public.membership_post_grace_renewal
    (tenant_id,member_id,previous_term_id,config_id,election_id,payment_method,first_payment_minor,currency,grace_end_date)
    VALUES(p_tenant_id,p_member_id,p_previous_term_id,p_config_id,e.id,p_method,p_first_payment_minor,p_currency,grace_end);
  RETURN to_jsonb(e);
END $$;
-- Staged: do not expose a new financial entry point before provider handlers
-- and recovery are connected to the atomic finalizer.
REVOKE ALL ON FUNCTION public.reserve_post_grace_renewal(uuid,uuid,uuid,uuid,text,bigint,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.post_grace_checkout_ready() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT has_function_privilege('service_role',
    'public.reserve_post_grace_renewal(uuid,uuid,uuid,uuid,text,bigint,text,jsonb)','EXECUTE')
    AND has_function_privilege('service_role',
    'public.apply_post_grace_record_dates(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)','EXECUTE');
$$;
REVOKE ALL ON FUNCTION public.post_grace_checkout_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.post_grace_checkout_ready() TO service_role;
COMMIT;
