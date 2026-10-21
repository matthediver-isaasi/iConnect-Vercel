-- REVIEWED DEPLOYMENT REQUIRED after 202612310022 and 202612310023.
-- No backfill, provider actions or existing-record changes. Unknown guard drift
-- aborts this entire transaction. Invoice/free are deliberately admin-only.
BEGIN;
CREATE TABLE public.member_start_payment_selection (
  start_id uuid PRIMARY KEY REFERENCES public.member_membership_start(id),
  payment_mode text NOT NULL CHECK (payment_mode IN ('stripe_upfront','stripe_monthly','direct_debit')),
  quote jsonb NOT NULL,
  before_history jsonb NOT NULL,
  after_history jsonb NOT NULL,
  before_token jsonb NOT NULL,
  after_token jsonb NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_start_payment_selection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_start_payment_selection FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_start_payment_selection TO service_role;
CREATE TRIGGER member_start_selection_immutable BEFORE UPDATE OR DELETE ON public.member_start_payment_selection
FOR EACH ROW EXECUTE FUNCTION public.member_start_immutable();

CREATE FUNCTION public.member_start_effective_quote(p_start_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT coalesce(c.quote,s.quote) FROM member_membership_start s
  LEFT JOIN member_start_payment_selection c ON c.start_id=s.id WHERE s.id=p_start_id;
$$;

-- A narrowly scoped transition witness, not a connection setting or bypass.
-- Both complete old/new rows (apart from an automatic updated_at stamp) must
-- exactly match the one service-only selection.
-- Once materialised, the old row can never match again.
CREATE FUNCTION public.member_start_selection_transition(t text,n jsonb,o jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT pg_trigger_depth()>0 AND EXISTS (SELECT FROM member_start_payment_selection c WHERE
    (t='member_membership_history' AND c.before_history-'updated_at'=o-'updated_at' AND c.after_history-'updated_at'=n-'updated_at')
    OR (t='membership_fee_token' AND c.before_token-'updated_at'=o-'updated_at' AND c.after_token-'updated_at'=n-'updated_at'));
$$;

CREATE FUNCTION public.validate_member_start_choices(q jsonb,r jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE p jsonb; cq jsonb; modes text[] := ARRAY[]::text[]; mode text; base jsonb;
BEGIN
  IF r->>'paymentMode' IS DISTINCT FROM 'member_choice' THEN RETURN; END IF;
  IF q->>'paymentMode' IS DISTINCT FROM 'member_choice' OR q->>'version' IS DISTINCT FROM '2'
    OR jsonb_typeof(q->'paymentChoices') IS DISTINCT FROM 'array'
    OR jsonb_array_length(q->'paymentChoices') NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Invalid member-choice quote';
  END IF;
  base:=q#>'{paymentChoices,0,quote}';
  IF (q-'paymentChoices'-'paymentMode') IS DISTINCT FROM (base-'paymentMode') THEN
    RAISE EXCEPTION 'Member-choice envelope differs from frozen initial authority';
  END IF;
  FOR p IN SELECT value FROM jsonb_array_elements(q->'paymentChoices') LOOP
    mode:=p->>'mode'; cq:=p->'quote';
    IF mode IS NULL OR mode NOT IN ('stripe_upfront','stripe_monthly','direct_debit') OR mode=ANY(modes)
      OR cq->>'paymentMode' IS DISTINCT FROM mode OR cq->>'version' IS DISTINCT FROM '2'
      OR cq->>'configId' IS DISTINCT FROM q->>'configId' OR cq->'bandId' IS DISTINCT FROM q->'bandId'
      OR cq->>'termStart' IS DISTINCT FROM q->>'termStart' OR cq->>'termEnd' IS DISTINCT FROM q->>'termEnd'
      OR cq->>'membershipYear' IS DISTINCT FROM q->>'membershipYear' OR cq->>'currency' IS DISTINCT FROM q->>'currency'
      OR cq->'targetSnapshot' IS DISTINCT FROM q->'targetSnapshot' OR cq->>'ownerState' IS DISTINCT FROM q->>'ownerState'
      OR cq#>>ARRAY['targetSnapshot','config',CASE mode WHEN 'stripe_upfront' THEN 'online_card_payment'
          WHEN 'stripe_monthly' THEN 'card_monthly_enabled' ELSE 'dd_enabled' END] IS DISTINCT FROM 'true'
      OR cq->>'annualCost' IS NULL OR (cq->>'annualCost')::numeric<0
      OR cq#>>'{commitment,term_start_date}' IS DISTINCT FROM q->>'termStart'
      OR cq#>>'{commitment,term_end_date}' IS DISTINCT FROM q->>'termEnd'
      OR cq#>>'{commitment,commitment_snapshot,payment_method}' IS DISTINCT FROM
        (CASE mode WHEN 'stripe_upfront' THEN 'stripe' WHEN 'stripe_monthly' THEN 'card_monthly' ELSE 'direct_debit' END) THEN
      RAISE EXCEPTION 'Invalid or duplicate frozen payment choice';
    END IF;
    IF mode='direct_debit' AND cq#>>'{paymentOffer,collectionPolicy,pricing_policy}'='dynamic' THEN
      IF cq->>'finalCost' IS NOT NULL OR cq->>'vatAmount' IS NOT NULL OR cq->>'totalWithVat' IS NOT NULL
        OR cq#>>'{commitment,commitment_snapshot,collection_policy,pricing_policy}' IS DISTINCT FROM 'dynamic' THEN
        RAISE EXCEPTION 'Invalid dynamic payment choice';
      END IF;
    ELSIF cq->>'totalWithVat' IS NULL OR (cq->>'totalWithVat')::numeric<=0
      OR cq->>'finalCost' IS NULL OR (cq->>'finalCost')::numeric<0
      OR cq->>'vatAmount' IS NULL OR (cq->>'vatAmount')::numeric<0
      OR (cq->>'totalWithVat')::numeric IS DISTINCT FROM (cq->>'finalCost')::numeric+(cq->>'vatAmount')::numeric THEN
      RAISE EXCEPTION 'Invalid exact frozen payment choice total';
    END IF;
    modes:=array_append(modes,mode);
  END LOOP;
END $$;

-- Preserve the original immutable request and all alternatives. Existing
-- attachment/activation/rolling guards consume the effective selected quote,
-- not a rewritten purchase or a current matching simulation.
DO $migration$
DECLARE d text; old text; fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['member_start_attachment_write(text,text,jsonb,jsonb,uuid)',
    'member_start_monthly_activation(jsonb,uuid)'] LOOP
    SELECT pg_get_functiondef(('public.'||fn)::regprocedure) INTO d;
    old:='SELECT * INTO s FROM member_membership_start WHERE record_id=history_id;';
    IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start effective authority guard drift: %',fn; END IF;
    d:=replace(d,old,old||$new$
  s.quote:=member_start_effective_quote(s.id);
  IF s.request->>'paymentMode'='member_choice' THEN
    s.request:=jsonb_set(s.request,'{paymentMode}',s.quote->'paymentMode');
  END IF;
$new$);
    IF fn LIKE 'member_start_attachment_write%' THEN
      old:=$old$mode:=s.request->>'paymentMode';$old$;
      IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start attachment mode guard drift'; END IF;
      d:=replace(d,old,old||$new$
  IF member_start_selection_transition(t,n,o) THEN RETURN true; END IF;
  IF mode IN ('member_choice','stripe_monthly','direct_debit') AND t IN ('membership_fee_token','member_membership_history')
    AND (n->>'stripe_payment_intent_id' IS NOT NULL OR n->>'stripe_payment_attempted_at' IS NOT NULL) THEN
    RAISE EXCEPTION 'Select one upfront card method before acquiring PaymentIntent authority';
  END IF;
  IF mode='member_choice' AND
    ((t='membership_fee_token' AND n->>'stripe_payment_intent_id' IS NOT NULL)
      OR (t='member_membership_history' AND (n->>'stripe_payment_intent_id' IS NOT NULL
        OR n->>'billing_agreement_id' IS NOT NULL OR n->>'instalment_plan_id' IS NOT NULL
        OR n->>'paid_at' IS NOT NULL OR n->>'accounting_invoice_id' IS NOT NULL OR n->>'xero_invoice_id' IS NOT NULL
        OR n->>'payment_status' IS DISTINCT FROM 'unpaid' OR n->>'status' IS DISTINCT FROM 'pending_payment_setup'))) THEN
    RAISE EXCEPTION 'Select one payment method before acquiring provider authority';
  END IF;
  IF mode='member_choice' AND t IN ('membership_billing_agreements','membership_payment_plans')
    THEN RAISE EXCEPTION 'Select one payment method before acquiring recurring authority'; END IF;
$new$);
      -- The token retains a durable marker after selection so same-mode
      -- selection retries can recover after a lost HTTP response.
      old:=$old$OR (op='UPDATE' AND EXISTS (SELECT FROM unnest(ARRAY['token','expires_at','cost_breakdown','tier_label']) k WHERE n->k IS DISTINCT FROM o->k))$old$;
      IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start token immutable guard drift'; END IF;
    END IF;
    EXECUTE d;
  END LOOP;
  SELECT pg_get_functiondef('public.member_start_owner_fence()'::regprocedure) INTO d;
  old:='SELECT s.record_id,s.quote,h.payment_status,h.term_end_date';
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start owner effective quote drift'; END IF;
  d:=replace(d,old,'SELECT s.record_id,member_start_effective_quote(s.id) AS quote,h.payment_status,h.term_end_date');
  EXECUTE d;
  SELECT pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure) INTO d;
  old:=$old$old_r := to_jsonb(OLD);$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Rolling selection transition guard drift'; END IF;
  d:=replace(d,old,old||$new$
    IF member_start_selection_transition(TG_TABLE_NAME,r,old_r) THEN RETURN NEW; END IF;
$new$);
  old:=$old$s.quote->'commitment'=c$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Rolling attachment effective quote drift'; END IF;
  d:=replace(d,old,$new$member_start_effective_quote(s.id)->'commitment'=c$new$);
  EXECUTE d;
END $migration$;

DO $migration$
DECLARE d text; old text;
BEGIN
  SELECT pg_get_functiondef('public.create_member_start(uuid,uuid,uuid,text,jsonb,jsonb)'::regprocedure) INTO d;
  old:=$old$coalesce(p_request->>'paymentMode','') NOT IN ('invoice','free','stripe_upfront','stripe_monthly','direct_debit')$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start creation modes drift'; END IF;
  d:=replace(d,old,$new$coalesce(p_request->>'paymentMode','') NOT IN ('invoice','free','stripe_upfront','stripe_monthly','direct_debit','member_choice')$new$);
  old:='PERFORM 1 FROM member WHERE tenant_id=p_tenant_id AND id=p_member_id FOR UPDATE;';
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start creation lock drift'; END IF;
  d:=replace(d,old,'PERFORM validate_member_start_choices(p_quote,p_request);'||E'\n  '||old);
  -- Reserve representative economics only. No provider authority can be
  -- acquired until selection, even if there is only one eligible option.
  old:=$old$CASE p_request->>'paymentMode' WHEN$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start initial economics drift'; END IF;
  d:=replace(d,old,$new$CASE coalesce(nullif(p_request->>'paymentMode','member_choice'),p_quote#>>'{paymentChoices,0,mode}') WHEN$new$);
  old:=$old$CASE WHEN p_request->>'paymentMode'='direct_debit'$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start dynamic validation drift'; END IF;
  d:=replace(d,old,$new$CASE WHEN coalesce(nullif(p_request->>'paymentMode','member_choice'),p_quote#>>'{paymentChoices,0,mode}')='direct_debit'$new$);
  old:=$old$IF p_request->>'paymentMode' IN ('stripe_upfront','stripe_monthly','direct_debit') THEN$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start token allocation drift'; END IF;
  d:=replace(d,old,$new$IF p_request->>'paymentMode' IN ('stripe_upfront','stripe_monthly','direct_debit','member_choice') THEN$new$);
  old:=$old$'tenantId',p_tenant_id,'memberId',p_member_id,'quote',p_quote)$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start choice token marker drift'; END IF;
  d:=replace(d,old,$new$'tenantId',p_tenant_id,'memberId',p_member_id,'quote',p_quote,
        'selectionRequired',p_request->>'paymentMode'='member_choice')$new$);
  EXECUTE d;
END $migration$;

CREATE FUNCTION public.select_member_start_payment_method(p_token_id uuid,p_payment_mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s member_membership_start; a member_start_payment_attachment; c member_start_payment_selection;
  h member_membership_history; t membership_fee_token; q jsonb; commitment jsonb;
  bh jsonb; ah jsonb; bt jsonb; atoken jsonb; cb jsonb;
BEGIN
  IF p_payment_mode IS NULL OR p_payment_mode NOT IN ('stripe_upfront','stripe_monthly','direct_debit') THEN
    RAISE EXCEPTION 'Select an enabled self-service payment method';
  END IF;
  SELECT ms.* INTO s FROM member_membership_start ms JOIN member_start_payment_attachment z ON z.start_id=ms.id
    WHERE z.token_id=p_token_id;
  IF NOT FOUND OR s.request->>'paymentMode' IS DISTINCT FROM 'member_choice' THEN
    RAISE EXCEPTION 'This purchase does not permit member payment selection';
  END IF;
  PERFORM 1 FROM member WHERE tenant_id=s.tenant_id AND id=s.member_id FOR UPDATE;
  SELECT * INTO a FROM member_start_payment_attachment WHERE start_id=s.id;
  SELECT * INTO t FROM membership_fee_token WHERE id=p_token_id FOR UPDATE;
  IF t.tenant_id IS DISTINCT FROM s.tenant_id OR t.member_id IS DISTINCT FROM s.member_id
    OR t.history_record_id IS DISTINCT FROM s.record_id OR t.expires_at<=now()
    OR t.status IN ('expired','cancelled') THEN RAISE EXCEPTION 'Payment link is unavailable; reconciliation is required'; END IF;
  SELECT * INTO c FROM member_start_payment_selection WHERE start_id=s.id;
  IF FOUND THEN
    IF c.payment_mode IS DISTINCT FROM p_payment_mode THEN RAISE EXCEPTION 'This purchase is already bound to another payment method'; END IF;
    RETURN jsonb_build_object('paymentMode',c.payment_mode,'selected',true,'replayed',true);
  END IF;
  SELECT * INTO h FROM member_membership_history WHERE id=s.record_id AND tenant_id=s.tenant_id FOR UPDATE;
  IF NOT FOUND OR h.member_id IS DISTINCT FROM s.member_id OR h.payment_status IS DISTINCT FROM 'unpaid'
    OR h.status IS DISTINCT FROM 'pending_payment_setup' OR h.stripe_payment_intent_id IS NOT NULL
    OR h.paid_at IS NOT NULL OR to_jsonb(h)->>'accounting_invoice_id' IS NOT NULL OR to_jsonb(h)->>'xero_invoice_id' IS NOT NULL
    OR h.billing_agreement_id IS NOT NULL OR to_jsonb(h)->>'instalment_plan_id' IS NOT NULL
    OR a.agreement_id IS NOT NULL OR a.plan_id IS NOT NULL OR t.stripe_payment_intent_id IS NOT NULL
    OR to_jsonb(t)->>'stripe_payment_attempted_at' IS NOT NULL
    OR t.status IS DISTINCT FROM 'pending'
    OR t.cost_breakdown#>'{memberStart,quote}' IS DISTINCT FROM s.quote THEN
    RAISE EXCEPTION 'Existing payment evidence requires reconciliation before selection';
  END IF;
  SELECT value->'quote' INTO q FROM jsonb_array_elements(s.quote->'paymentChoices') WHERE value->>'mode'=p_payment_mode;
  IF q IS NULL THEN RAISE EXCEPTION 'This method was not offered in the confirmed purchase'; END IF;
  commitment:=q->'commitment';
  bh:=to_jsonb(h); bt:=to_jsonb(t);
  ah:=bh||jsonb_build_object(
    'annual_cost',q->'annualCost','prorata_cost',q->'finalCost','final_cost',q->'finalCost',
    'vat_rate_percent',q->'vatRatePercent','vat_amount',q->'vatAmount','total_with_vat',q->'totalWithVat',
    'payment_method',CASE p_payment_mode WHEN 'stripe_upfront' THEN 'stripe' WHEN 'stripe_monthly' THEN 'card_monthly' ELSE 'direct_debit' END,
    'billing_period',CASE p_payment_mode WHEN 'stripe_upfront' THEN 'annual' WHEN 'stripe_monthly' THEN 'monthly_card' ELSE 'monthly_direct_debit' END,
    'membership_renewal_date',commitment->'membership_renewal_date','term_duration_months',commitment->'term_duration_months',
    'term_anchor_date',commitment->'term_anchor_date','term_key',commitment->'term_key',
    'commitment_snapshot',CASE WHEN commitment->>'term_key' IS NOT NULL THEN commitment->'commitment_snapshot' ELSE 'null'::jsonb END);
  cb:=t.cost_breakdown||jsonb_build_object(
    'memberStart',jsonb_set(t.cost_breakdown->'memberStart','{quote}',q),
    'annualCost',q->'annualCost','vatAmount',q->'vatAmount','vatRatePercent',q->'vatRatePercent',
    'totalWithVat',q->'totalWithVat','taxType',q->'taxType','matchedBand',q#>'{targetSnapshot,band}');
  atoken:=bt||jsonb_build_object('final_cost',q->'finalCost','cost_breakdown',cb);
  INSERT INTO member_start_payment_selection(start_id,payment_mode,quote,before_history,after_history,before_token,after_token)
    VALUES(s.id,p_payment_mode,q,bh,ah,bt,atoken);
  SELECT * INTO h FROM jsonb_populate_record(NULL::member_membership_history,ah);
  UPDATE member_membership_history SET annual_cost=h.annual_cost,prorata_cost=h.prorata_cost,final_cost=h.final_cost,
    vat_rate_percent=h.vat_rate_percent,vat_amount=h.vat_amount,total_with_vat=h.total_with_vat,
    payment_method=h.payment_method,billing_period=h.billing_period,membership_renewal_date=h.membership_renewal_date,
    term_duration_months=h.term_duration_months,term_anchor_date=h.term_anchor_date,term_key=h.term_key,
    commitment_snapshot=h.commitment_snapshot WHERE id=s.record_id;
  UPDATE membership_fee_token SET final_cost=(q->>'finalCost')::numeric,cost_breakdown=cb WHERE id=p_token_id;
  RETURN jsonb_build_object('paymentMode',p_payment_mode,'selected',true,'replayed',false);
END $$;

CREATE OR REPLACE FUNCTION public.member_start_payment_capabilities() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('version',2,'memberChoice',true,
    'paymentModes',jsonb_build_array('stripe_upfront','stripe_monthly','direct_debit','member_choice'));
$$;
REVOKE ALL ON FUNCTION public.member_start_effective_quote(uuid),
  public.member_start_selection_transition(text,jsonb,jsonb),public.validate_member_start_choices(jsonb,jsonb),
  public.select_member_start_payment_method(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.select_member_start_payment_method(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.member_start_effective_quote(uuid),
  public.member_start_selection_transition(text,jsonb,jsonb) TO service_role;
-- The existing rolling trigger is SECURITY INVOKER. Its read-only witness must
-- remain callable for legacy authenticated updates too; outside a trigger it
-- always returns false and never exposes purchase/selection contents.
GRANT EXECUTE ON FUNCTION public.member_start_selection_transition(text,jsonb,jsonb) TO anon,authenticated;
COMMIT;
