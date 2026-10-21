-- Reviewed deployment required. No legacy backfill or policy assignment.
BEGIN;
CREATE TABLE public.member_membership_start (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  actor_id uuid NOT NULL,
  record_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  request jsonb NOT NULL,
  quote jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,member_id,idempotency_key)
);
ALTER TABLE public.member_membership_start ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_membership_start FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_membership_start TO service_role;
CREATE FUNCTION public.member_start_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Membership start purchase authority is immutable'; END $$;
CREATE TRIGGER member_start_immutable BEFORE UPDATE OR DELETE ON public.member_membership_start
FOR EACH ROW EXECUTE FUNCTION public.member_start_immutable();

CREATE FUNCTION public.member_start_state(p_tenant_id uuid,p_member_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m jsonb; histories jsonb; agreements jsonb; plans jsonb; quotes jsonb; tokens jsonb; elections jsonb;
  blockers jsonb := '[]'; today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  SELECT to_jsonb(t) INTO m FROM member t WHERE tenant_id=p_tenant_id AND id=p_member_id;
  IF m IS NULL THEN RETURN jsonb_build_object('member',null,'blockers','[]'::jsonb); END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') INTO histories FROM member_membership_history t WHERE tenant_id=p_tenant_id AND member_id=p_member_id;
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') INTO agreements FROM membership_billing_agreements t WHERE tenant_id=p_tenant_id AND member_id=p_member_id;
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') INTO plans FROM membership_payment_plans t WHERE tenant_id=p_tenant_id AND member_id=p_member_id;
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') INTO quotes FROM membership_payment_quote t WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND organization_id IS NULL;
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') INTO tokens FROM membership_fee_token t WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND organization_id IS NULL;
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') INTO elections FROM membership_successor_election t WHERE tenant_id=p_tenant_id AND member_id=p_member_id;
  IF EXISTS (SELECT FROM jsonb_array_elements(histories) h WHERE
    h->>'payment_status' IS DISTINCT FROM 'voided'
    AND (h->>'payment_status' IS DISTINCT FROM 'paid' OR h->>'term_start_date' IS NULL
      OR h->>'term_end_date' IS NULL OR (h->>'term_end_date')::date >= today)) THEN
    blockers := blockers || '"A current, future, unpaid or undated historical purchase requires review. Use amendment/renewal settlement rather than start another purchase."'::jsonb;
  END IF;
  IF EXISTS (SELECT FROM jsonb_array_elements(agreements) a WHERE coalesce(a->>'status','') NOT IN ('cancelled','expired','failed'))
    OR jsonb_array_length(plans)>0 THEN
    blockers := blockers || '"Recurring agreements or payment-plan obligations require finance review; no new recurring consent is inferred."'::jsonb;
  END IF;
  -- Even an expired bearer URL may own an unresolved provider intent. Only
  -- conclusively consumed/cancelled evidence may be ignored.
  IF EXISTS (SELECT FROM jsonb_array_elements(tokens) t WHERE coalesce(t->>'status','') NOT IN ('paid','cancelled')
      OR (t->>'status'='cancelled' AND t->>'stripe_payment_intent_id' IS NOT NULL))
    OR EXISTS (SELECT FROM jsonb_array_elements(quotes) q WHERE NOT EXISTS
      (SELECT FROM jsonb_array_elements(histories) h WHERE h->>'payment_status'='paid'
       AND h->>'stripe_payment_intent_id'=q->>'stripe_payment_intent_id'))
    OR EXISTS (SELECT FROM jsonb_array_elements(elections) e WHERE e->>'status' IS DISTINCT FROM 'released'
      AND (e->>'term_end_date')::date >= today) THEN
    blockers := blockers || '"A payment quote, fee link or successor reservation already owns pending obligations; reconcile it first."'::jsonb;
  END IF;
  RETURN jsonb_build_object('member',m,'blockers',blockers,'fingerprint',
    md5(jsonb_build_array(m,histories,agreements,plans,quotes,tokens,elections)::text));
END $$;

-- All participating creators serialize on the same member. Triggers run even
-- for legacy entry points, so a parallel checkout cannot slip between discovery
-- and the atomic insert. They do not change any existing purchase.
CREATE FUNCTION public.member_start_owner_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; payload jsonb := to_jsonb(NEW); old_payload jsonb; candidate_start date;
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='member_membership_history'
    AND EXISTS (SELECT FROM member_membership_start WHERE record_id=OLD.id)
    AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.member_id IS DISTINCT FROM OLD.member_id) THEN
    RAISE EXCEPTION 'Admin-start purchase ownership is immutable';
  END IF;
  IF payload->>'member_id' IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM member WHERE tenant_id=(payload->>'tenant_id')::uuid AND id=(payload->>'member_id')::uuid FOR UPDATE;
  IF TG_OP='UPDATE' THEN old_payload:=to_jsonb(OLD); END IF;
  FOR r IN SELECT s.record_id,s.quote,h.payment_status,h.term_end_date
    FROM member_membership_start s JOIN member_membership_history h ON h.id=s.record_id
    WHERE s.tenant_id=(payload->>'tenant_id')::uuid AND s.member_id=(payload->>'member_id')::uuid LOOP
    candidate_start := coalesce(payload->>'term_start_date',
      payload#>>'{quote,simResult,commitment,term_start_date}',
      payload#>>'{quote,simResult,membershipYear,start}',
      payload#>>'{cost_breakdown,commitment,term_start_date}',
      payload#>>'{cost_breakdown,renewalQuote,membershipYear,start}')::date;
    IF TG_TABLE_NAME='member_membership_history' AND r.record_id=(payload->>'id')::uuid THEN
      IF TG_OP='UPDATE' AND EXISTS (SELECT FROM unnest(ARRAY['tenant_id','member_id','organization_id',
        'config_id','band_id','tier_label','field_value','annual_cost','prorata_cost','final_cost','vat_rate_percent','vat_amount','total_with_vat',
        'free_period_discount','rollover_discount','custom_discount_total','custom_discount_details','incentive_snapshot',
        'currency','billing_period','membership_year','term_start_date','term_end_date','membership_renewal_date',
        'term_duration_months','term_anchor_date','term_key','previous_term_id','commitment_snapshot',
        'billing_agreement_id','instalment_plan_id','form_submission_id','payment_method']) k
        WHERE payload->k IS DISTINCT FROM old_payload->k) THEN
        RAISE EXCEPTION 'Admin-start purchase economics and ownership are immutable';
      END IF;
      IF payload->>'status' IN ('active','scheduled') AND payload->>'payment_status' IS DISTINCT FROM 'paid' THEN
        RAISE EXCEPTION 'Admin-start invoice membership cannot activate before settlement';
      END IF;
    ELSIF TG_OP='INSERT' OR (TG_OP='UPDATE' AND EXISTS (
      SELECT FROM unnest(ARRAY['member_id','tenant_id','status','payment_status','stripe_payment_intent_id',
        'term_start_date','term_end_date','membership_renewal_date']) k
      WHERE payload->k IS DISTINCT FROM old_payload->k)) THEN
      IF r.payment_status NOT IN ('paid','voided')
        OR (r.term_end_date >= (now() AT TIME ZONE 'UTC')::date
          AND (candidate_start IS NULL OR candidate_start <= r.term_end_date)) THEN
        RAISE EXCEPTION 'An admin-start purchase already owns this member term; reconcile it before another financial commitment' USING ERRCODE='40001';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['member_membership_history','membership_billing_agreements','membership_payment_plans',
    'membership_payment_quote','membership_fee_token','membership_successor_election'] LOOP
    EXECUTE format('CREATE TRIGGER member_start_owner_fence BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.member_start_owner_fence()',t);
  END LOOP;
END $$;

CREATE FUNCTION public.create_member_start(p_tenant_id uuid,p_member_id uuid,p_actor_id uuid,
  p_idempotency_key text,p_request jsonb,p_quote jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved member_membership_start; s jsonb; cfg jsonb; band jsonb; vat jsonb;
  c jsonb := p_quote->'commitment'; record_id uuid; starts date; ends date; free boolean;
  today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_actor_id IS NULL OR p_request->>'memberId' IS DISTINCT FROM p_member_id::text
    OR coalesce(p_request->>'expectedQuote','') !~ '^[a-f0-9]{64}$'
    OR length(btrim(coalesce(p_request->>'reason',''))) NOT BETWEEN 1 AND 2000
    OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_.:-]{8,128}$'
    OR p_request->>'paymentMode' NOT IN ('invoice','free') THEN RAISE EXCEPTION 'Invalid start confirmation'; END IF;
  PERFORM 1 FROM member WHERE tenant_id=p_tenant_id AND id=p_member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found in tenant'; END IF;
  SELECT * INTO saved FROM member_membership_start WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF saved.request IS DISTINCT FROM p_request THEN RAISE EXCEPTION 'Idempotency key belongs to another request'; END IF;
    RETURN jsonb_build_object('request',to_jsonb(saved),'replayed',true);
  END IF;
  s := member_start_state(p_tenant_id,p_member_id);
  IF jsonb_array_length(s->'blockers')>0 OR s->>'fingerprint' IS DISTINCT FROM p_quote->>'ownerState' THEN
    RAISE EXCEPTION 'Member obligations changed; preview again' USING ERRCODE='40001';
  END IF;
  SELECT to_jsonb(t) INTO cfg FROM membership_tier_config t
    WHERE tenant_id=p_tenant_id AND id=(p_request->>'configId')::uuid FOR SHARE;
  IF cfg IS NULL OR cfg IS DISTINCT FROM p_quote#>'{targetSnapshot,config}' THEN RAISE EXCEPTION 'Structure changed; preview again'; END IF;
  IF p_request->>'bandId' IS NOT NULL THEN
    SELECT to_jsonb(t) INTO band FROM membership_tier_band t WHERE tenant_id=p_tenant_id
      AND config_id=(p_request->>'configId')::uuid AND id=(p_request->>'bandId')::uuid FOR SHARE;
    IF band IS NULL OR band IS DISTINCT FROM p_quote#>'{targetSnapshot,band}' THEN RAISE EXCEPTION 'Band changed; preview again'; END IF;
  END IF;
  SELECT to_jsonb(t) INTO vat FROM system_settings t WHERE tenant_id=p_tenant_id AND setting_key='xero_vat_rates_'||p_tenant_id::text;
  IF coalesce(vat,'null') IS DISTINCT FROM p_quote#>'{targetSnapshot,vatSetting}'
    OR EXISTS (SELECT FROM membership_tier_discount WHERE tenant_id=p_tenant_id AND config_id=(p_request->>'configId')::uuid)
    OR EXISTS (SELECT FROM membership_tier_vat_override WHERE tenant_id=p_tenant_id AND config_id=(p_request->>'configId')::uuid)
    OR EXISTS (SELECT FROM member_membership_override WHERE tenant_id=p_tenant_id AND member_id=p_member_id) THEN
    RAISE EXCEPTION 'Pricing policy changed; preview again';
  END IF;
  starts := (p_quote->>'termStart')::date; ends := (p_quote->>'termEnd')::date;
  free := p_request->>'paymentMode'='free';
  IF starts IS NULL OR starts<today OR ends IS NULL OR ends<starts OR starts IS DISTINCT FROM (p_request->>'startDate')::date
    OR free IS DISTINCT FROM ((p_quote->>'totalWithVat')::numeric=0)
    OR (p_quote->>'finalCost')::numeric<0 OR (p_quote->>'vatAmount')::numeric<0
    OR (p_quote->>'totalWithVat')::numeric IS DISTINCT FROM ((p_quote->>'finalCost')::numeric+(p_quote->>'vatAmount')::numeric) THEN
    RAISE EXCEPTION 'Invalid term or exact payment total';
  END IF;
  INSERT INTO member_membership_history (tenant_id,member_id,membership_year,config_id,band_id,tier_label,
    annual_cost,prorata_cost,final_cost,currency,billing_period,vat_rate_percent,vat_amount,total_with_vat,
    term_start_date,term_end_date,membership_renewal_date,term_duration_months,term_anchor_date,term_key,
    commitment_snapshot,status,payment_status,payment_method,paid_at,scheduled_activation_date,notes)
  VALUES (p_tenant_id,p_member_id,p_quote->>'membershipYear',(p_request->>'configId')::uuid,(p_request->>'bandId')::uuid,p_quote->>'tierLabel',
    (p_quote->>'annualCost')::numeric,(p_quote->>'finalCost')::numeric,(p_quote->>'finalCost')::numeric,p_quote->>'currency','annual',
    (p_quote->>'vatRatePercent')::numeric,(p_quote->>'vatAmount')::numeric,(p_quote->>'totalWithVat')::numeric,
    starts,ends,(c->>'membership_renewal_date')::date,(c->>'term_duration_months')::integer,(c->>'term_anchor_date')::date,c->>'term_key',
    CASE WHEN c->>'term_key' IS NOT NULL THEN c->'commitment_snapshot' ELSE NULL END,
    CASE WHEN NOT free THEN 'pending_payment_setup' WHEN starts>today THEN 'scheduled' ELSE 'active' END,
    CASE WHEN free THEN 'paid' ELSE 'unpaid' END,CASE WHEN free THEN NULL ELSE 'invoice' END,
    CASE WHEN free THEN now() ELSE NULL END,CASE WHEN free AND starts>today THEN starts ELSE NULL END,
    'Explicit admin Start purchase. No historical commencement or payment inferred. Reason: '||(p_request->>'reason'))
  RETURNING id INTO record_id;
  INSERT INTO member_membership_start(tenant_id,member_id,actor_id,record_id,idempotency_key,request,quote)
    VALUES(p_tenant_id,p_member_id,p_actor_id,record_id,p_idempotency_key,p_request,p_quote) RETURNING * INTO saved;
  RETURN jsonb_build_object('request',to_jsonb(saved),'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.member_start_state(uuid,uuid), public.create_member_start(uuid,uuid,uuid,text,jsonb,jsonb),
  public.member_start_owner_fence(),public.member_start_immutable() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_start_state(uuid,uuid), public.create_member_start(uuid,uuid,uuid,text,jsonb,jsonb) TO service_role;
COMMIT;
