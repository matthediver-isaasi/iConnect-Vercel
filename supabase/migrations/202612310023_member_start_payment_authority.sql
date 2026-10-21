-- REVIEW REQUIRED: additive service-only Start payment attachment authority.
-- No backfill, provider calls, trigger disabling or production application.
BEGIN;
CREATE TABLE public.member_start_payment_attachment (
  start_id uuid PRIMARY KEY REFERENCES public.member_membership_start(id),
  token_id uuid NOT NULL UNIQUE,
  agreement_id uuid UNIQUE,
  plan_id uuid UNIQUE
);
ALTER TABLE public.member_start_payment_attachment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_start_payment_attachment FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_start_payment_attachment TO service_role;
CREATE FUNCTION public.member_start_payment_capabilities() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('version',1,'paymentModes',jsonb_build_array('stripe_upfront','stripe_monthly','direct_debit'));
$$;
CREATE FUNCTION public.member_start_payment_delete_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM member WHERE tenant_id=OLD.tenant_id AND id=OLD.member_id FOR UPDATE;
  IF EXISTS (SELECT FROM member_start_payment_attachment a WHERE
    (TG_TABLE_NAME='membership_fee_token' AND a.token_id=OLD.id)
    OR (TG_TABLE_NAME='membership_billing_agreements' AND a.agreement_id=OLD.id)
    OR (TG_TABLE_NAME='membership_payment_plans' AND a.plan_id=OLD.id)) THEN
    RAISE EXCEPTION 'Start payment attachment evidence cannot be deleted';
  END IF;
  RETURN OLD;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_fee_token','membership_billing_agreements','membership_payment_plans'] LOOP
    EXECUTE format('CREATE TRIGGER member_start_payment_delete_fence BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.member_start_payment_delete_fence()',t);
  END LOOP;
END $$;

-- Invoked only inside the existing member-lock fence. The bearer token,
-- agreement and plan must all belong to the one immutable purchase.
CREATE FUNCTION public.member_start_attachment_write(t text, op text, n jsonb, o jsonb, history_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s member_membership_start; a member_start_payment_attachment; terms jsonb; mode text; owned boolean := false;
BEGIN
  SELECT * INTO s FROM member_membership_start WHERE record_id=history_id;
  SELECT * INTO a FROM member_start_payment_attachment WHERE start_id=s.id;
  IF NOT FOUND THEN
    IF t='member_membership_history' AND op='UPDATE' AND (n->>'id')::uuid=s.record_id
      AND (n->'billing_agreement_id' IS DISTINCT FROM o->'billing_agreement_id'
        OR n->'instalment_plan_id' IS DISTINCT FROM o->'instalment_plan_id') THEN
      RAISE EXCEPTION 'Non-recurring Start payment attachments are immutable';
    END IF;
    RETURN false;
  END IF;
  mode:=s.request->>'paymentMode';
  IF t='membership_fee_token' AND (n->>'id')::uuid=a.token_id THEN
    IF n->>'tenant_id' IS DISTINCT FROM s.tenant_id::text OR n->>'member_id' IS DISTINCT FROM s.member_id::text
      OR n->>'organization_id' IS NOT NULL OR n->>'history_record_id' IS DISTINCT FROM s.record_id::text
      OR n->>'membership_year' IS DISTINCT FROM s.quote->>'membershipYear'
      OR (n->>'final_cost')::numeric IS DISTINCT FROM (s.quote->>'finalCost')::numeric
      OR n->>'currency' IS DISTINCT FROM s.quote->>'currency'
      OR n#>'{cost_breakdown,memberStart,quote}' IS DISTINCT FROM s.quote
      OR n#>>'{cost_breakdown,memberStart,requestId}' IS DISTINCT FROM s.id::text
      OR n#>>'{cost_breakdown,memberStart,recordId}' IS DISTINCT FROM s.record_id::text
      OR n#>>'{cost_breakdown,memberStart,tenantId}' IS DISTINCT FROM s.tenant_id::text
      OR n#>>'{cost_breakdown,memberStart,memberId}' IS DISTINCT FROM s.member_id::text
      OR n#>>'{cost_breakdown,memberStart,version}' IS DISTINCT FROM '1'
      OR (op='UPDATE' AND EXISTS (SELECT FROM unnest(ARRAY['token','expires_at','cost_breakdown','tier_label']) k WHERE n->k IS DISTINCT FROM o->k))
      THEN RAISE EXCEPTION 'Start payment token authority is immutable'; END IF;
    RETURN true;
  END IF;
  IF t='membership_billing_agreements' AND
      (n#>>'{metadata,member_start,requestId}'=s.id::text OR (n->>'id')::uuid=a.agreement_id) THEN
    terms:=CASE WHEN mode='stripe_monthly' THEN n#>'{metadata,card}' ELSE n#>'{metadata,dd}' END;
    IF mode NOT IN ('stripe_monthly','direct_debit')
      OR n->>'tenant_id' IS DISTINCT FROM s.tenant_id::text OR n->>'member_id' IS DISTINCT FROM s.member_id::text
      OR n->>'organization_id' IS NOT NULL
      OR coalesce(n->>'provider','gocardless') IS DISTINCT FROM (CASE WHEN mode='stripe_monthly' THEN 'stripe' ELSE 'gocardless' END)
      OR terms->'commitment' IS DISTINCT FROM s.quote->'commitment'
      OR (terms->>'monthly_amount')::numeric IS DISTINCT FROM (s.quote#>>'{paymentOffer,monthlyAmount}')::numeric
      OR (terms->>'instalment_count')::int IS DISTINCT FROM (s.quote#>>'{paymentOffer,instalmentCount}')::int
      OR terms->>'activation_rule' IS DISTINCT FROM s.quote#>>'{paymentOffer,activationRule}'
      OR terms->>'currency' IS DISTINCT FROM s.quote->>'currency'
      OR terms->>'membership_year' IS DISTINCT FROM s.quote->>'membershipYear'
      OR (a.agreement_id IS NOT NULL AND a.agreement_id IS DISTINCT FROM (n->>'id')::uuid)
      OR (op='UPDATE' AND EXISTS (SELECT FROM unnest(ARRAY['id','tenant_id','member_id','organization_id','provider','idempotency_key','environment',
        'term_start_date','term_end_date','membership_renewal_date','term_key','commitment_snapshot']) k WHERE n->k IS DISTINCT FROM o->k))
      OR (op='UPDATE' AND n#>'{metadata,member_start}' IS DISTINCT FROM o#>'{metadata,member_start}')
      THEN RAISE EXCEPTION 'Start billing agreement differs from the purchased payment authority'; END IF;
    UPDATE member_start_payment_attachment SET agreement_id=(n->>'id')::uuid WHERE start_id=s.id AND agreement_id IS NULL;
    RETURN true;
  END IF;
  IF t='membership_payment_plans' AND (n->>'billing_agreement_id')::uuid=a.agreement_id THEN
    IF n->>'tenant_id' IS DISTINCT FROM s.tenant_id::text OR n->>'member_id' IS DISTINCT FROM s.member_id::text
      OR n->>'organization_id' IS NOT NULL
      OR coalesce(n->>'provider','gocardless') IS DISTINCT FROM (CASE WHEN mode='stripe_monthly' THEN 'stripe' ELSE 'gocardless' END)
      OR (n->>'amount_minor')::numeric IS DISTINCT FROM (s.quote#>>'{paymentOffer,monthlyAmountMinor}')::numeric
      OR (n->>'instalments_total')::int IS DISTINCT FROM (s.quote#>>'{paymentOffer,instalmentCount}')::int
      OR n->>'currency' IS DISTINCT FROM s.quote->>'currency'
      OR n->>'membership_year' IS DISTINCT FROM s.quote->>'membershipYear'
      OR (a.plan_id IS NOT NULL AND a.plan_id IS DISTINCT FROM (n->>'id')::uuid)
      OR (op='UPDATE' AND EXISTS (SELECT FROM unnest(ARRAY['id','tenant_id','member_id','organization_id','billing_agreement_id',
        'provider','amount_minor','instalments_total','currency','membership_year','idempotency_key','environment']) k WHERE n->k IS DISTINCT FROM o->k))
      THEN RAISE EXCEPTION 'Start payment plan differs from the purchased payment authority'; END IF;
    UPDATE member_start_payment_attachment SET plan_id=(n->>'id')::uuid WHERE start_id=s.id AND plan_id IS NULL;
    RETURN true;
  END IF;
  IF t='member_membership_history' AND (n->>'id')::uuid=s.record_id THEN
    IF (n->>'billing_agreement_id')::uuid IS DISTINCT FROM a.agreement_id
        AND (n->>'billing_agreement_id') IS NOT NULL
      OR (n->>'instalment_plan_id')::uuid IS DISTINCT FROM a.plan_id AND n->>'instalment_plan_id' IS NOT NULL
      OR (o->>'billing_agreement_id' IS NOT NULL AND n->>'billing_agreement_id' IS DISTINCT FROM o->>'billing_agreement_id')
      OR (o->>'instalment_plan_id' IS NOT NULL AND n->>'instalment_plan_id' IS DISTINCT FROM o->>'instalment_plan_id')
      THEN RAISE EXCEPTION 'Start history payment attachment identity is immutable'; END IF;
  END IF;
  RETURN false;
END $$;

CREATE FUNCTION public.member_start_monthly_activation(n jsonb, history_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s member_membership_start; a member_start_payment_attachment; g jsonb; rule text;
BEGIN
  SELECT * INTO s FROM member_membership_start WHERE record_id=history_id;
  IF s.request->>'paymentMode' NOT IN ('stripe_monthly','direct_debit') THEN RETURN false; END IF;
  SELECT * INTO a FROM member_start_payment_attachment WHERE start_id=s.id;
  IF a.agreement_id IS NULL OR (n->>'billing_agreement_id')::uuid IS DISTINCT FROM a.agreement_id THEN RETURN false; END IF;
  SELECT to_jsonb(t) INTO g FROM membership_billing_agreements t WHERE id=a.agreement_id;
  rule:=s.quote#>>'{paymentOffer,activationRule}';
  -- Existing verified processing and manual-approval RPC retain their authority;
  -- an unowned or unconsented agreement can never unlock activation.
  RETURN (rule='first_payment' AND EXISTS (SELECT FROM membership_payment_plans p
      WHERE p.id=a.plan_id AND (to_jsonb(p)->>'instalments_paid')::int>0))
    OR (rule='mandate' AND (g->>'gocardless_mandate_id' IS NOT NULL OR g->>'stripe_subscription_id' IS NOT NULL)
      AND g->>'status' IN ('active','first_payment_pending'))
    OR (rule='manual' AND g#>>'{metadata,member_start_manual_activation,approved_at}' IS NOT NULL);
END $$;

CREATE FUNCTION public.attach_member_start_agreement(p_start_id uuid,p_agreement_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s member_membership_start; a member_start_payment_attachment; h jsonb;
BEGIN
  SELECT * INTO s FROM member_membership_start WHERE id=p_start_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Start purchase not found'; END IF;
  PERFORM 1 FROM member WHERE tenant_id=s.tenant_id AND id=s.member_id FOR UPDATE;
  SELECT * INTO a FROM member_start_payment_attachment WHERE start_id=s.id;
  IF a.agreement_id IS DISTINCT FROM p_agreement_id OR p_agreement_id IS NULL THEN RAISE EXCEPTION 'Agreement is not owned by this Start purchase'; END IF;
  UPDATE member_membership_history SET billing_agreement_id=p_agreement_id WHERE id=s.record_id AND tenant_id=s.tenant_id;
  SELECT to_jsonb(t) INTO h FROM member_membership_history t WHERE id=s.record_id;
  RETURN h;
END $$;

-- Extend, do not replace or disable, the deployed ownership/economic fences.
DO $migration$
DECLARE d text; old text; replacement text;
BEGIN
  SELECT pg_get_functiondef('public.member_start_owner_fence()'::regprocedure) INTO d;
  old := $old$IF payload->>'member_id' IS NULL THEN RETURN NEW; END IF;$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start owner identity guard drift'; END IF;
  d:=replace(d,old,$new$IF TG_OP='UPDATE' AND EXISTS (
      SELECT FROM member_start_payment_attachment z WHERE
        (TG_TABLE_NAME='membership_fee_token' AND z.token_id=OLD.id)
        OR (TG_TABLE_NAME='membership_billing_agreements' AND z.agreement_id=OLD.id)
        OR (TG_TABLE_NAME='membership_payment_plans' AND z.plan_id=OLD.id)) AND
      (NEW.id IS DISTINCT FROM OLD.id OR payload->>'tenant_id' IS DISTINCT FROM to_jsonb(OLD)->>'tenant_id'
        OR payload->>'member_id' IS DISTINCT FROM to_jsonb(OLD)->>'member_id'
        OR payload->>'organization_id' IS DISTINCT FROM to_jsonb(OLD)->>'organization_id') THEN
      RAISE EXCEPTION 'Start payment attachment ownership is immutable';
    END IF;
    IF payload->>'member_id' IS NULL THEN RETURN NEW; END IF;$new$);
  old := $old$IF TG_TABLE_NAME='member_membership_history' AND r.record_id=(payload->>'id')::uuid THEN$old$;
  replacement := $new$IF member_start_attachment_write(TG_TABLE_NAME,TG_OP,payload,old_payload,r.record_id) THEN CONTINUE; END IF;
    IF TG_TABLE_NAME='member_membership_history' AND r.record_id=(payload->>'id')::uuid THEN$new$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start owner fence drift; review migration'; END IF;
  d:=replace(d,old,replacement);
  old := $old$'billing_agreement_id','instalment_plan_id','form_submission_id','payment_method'$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start immutable field fence drift'; END IF;
  d:=replace(d,old,$new$'form_submission_id','payment_method'$new$);
  old := $old$IF payload->>'status' IN ('active','scheduled') AND payload->>'payment_status' IS DISTINCT FROM 'paid' THEN$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start activation fence drift'; END IF;
  d:=replace(d,old,$new$IF payload->>'status' IN ('active','scheduled') AND payload->>'payment_status' IS DISTINCT FROM 'paid'
        AND NOT member_start_monthly_activation(payload,r.record_id) THEN$new$);
  EXECUTE d;
END $migration$;

-- Creation remains the same state/pricing recheck and the same member lock.
-- Allocate the one bearer identity transactionally with its immutable purchase.
DO $migration$
DECLARE d text; old text;
BEGIN
  SELECT pg_get_functiondef('public.create_member_start(uuid,uuid,uuid,text,jsonb,jsonb)'::regprocedure) INTO d;
  old := $old$p_request->>'paymentMode' NOT IN ('invoice','free')$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start payment mode validation drift'; END IF;
  d:=replace(d,old,$new$coalesce(p_request->>'paymentMode','') NOT IN ('invoice','free','stripe_upfront','stripe_monthly','direct_debit')$new$);
  old := $old$p_quote->>'currency','annual',$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start billing period insertion drift'; END IF;
  d:=replace(d,old,$new$p_quote->>'currency',CASE p_request->>'paymentMode' WHEN 'stripe_monthly' THEN 'monthly_card' WHEN 'direct_debit' THEN 'monthly_direct_debit' ELSE 'annual' END,$new$);
  old := $old$CASE WHEN free THEN NULL ELSE 'invoice' END,$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start payment method insertion drift'; END IF;
  d:=replace(d,old,$new$CASE p_request->>'paymentMode' WHEN 'free' THEN NULL WHEN 'stripe_upfront' THEN 'stripe' WHEN 'stripe_monthly' THEN 'card_monthly' WHEN 'direct_debit' THEN 'direct_debit' ELSE 'invoice' END,$new$);
  old:=$old$OR free IS DISTINCT FROM ((p_quote->>'totalWithVat')::numeric=0)$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start exact total validation drift'; END IF;
  d:=replace(d,old,$new$OR (CASE WHEN p_request->>'paymentMode'='direct_debit'
      AND cfg->>'dd_policy_version'='1' AND cfg->>'dd_pricing_policy'='dynamic'
      AND cfg->>'dd_invoicing_mode'='per_instalment' THEN
        free OR p_quote->>'finalCost' IS NOT NULL OR p_quote->>'vatAmount' IS NOT NULL OR p_quote->>'totalWithVat' IS NOT NULL
        OR p_quote#>>'{paymentOffer,collectionPolicy,pricing_policy}' IS DISTINCT FROM 'dynamic'
        OR c#>>'{commitment_snapshot,collection_policy,pricing_policy}' IS DISTINCT FROM 'dynamic'
      ELSE free IS DISTINCT FROM ((p_quote->>'totalWithVat')::numeric=0) END)$new$);
  old := $old$VALUES(p_tenant_id,p_member_id,p_actor_id,record_id,p_idempotency_key,p_request,p_quote) RETURNING * INTO saved;$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Start purchase insert drift'; END IF;
  d:=replace(d,old,old || $new$
  IF p_request->>'paymentMode' IN ('stripe_upfront','stripe_monthly','direct_debit') THEN
    IF p_quote->>'version' IS DISTINCT FROM '2'
      OR p_quote->>'paymentMode' IS DISTINCT FROM p_request->>'paymentMode'
      OR (p_request->>'paymentMode'='stripe_upfront' AND cfg->>'online_card_payment' IS DISTINCT FROM 'true')
      OR (p_request->>'paymentMode'='stripe_monthly' AND cfg->>'card_monthly_enabled' IS DISTINCT FROM 'true')
      OR (p_request->>'paymentMode'='direct_debit' AND cfg->>'dd_enabled' IS DISTINCT FROM 'true')
      THEN RAISE EXCEPTION 'Structure does not enable the selected payment method'; END IF;
    INSERT INTO member_start_payment_attachment(start_id,token_id) VALUES(saved.id,gen_random_uuid());
    INSERT INTO membership_fee_token(id,token,tenant_id,member_id,membership_year,status,final_cost,currency,tier_label,
      cost_breakdown,history_record_id,recipient_email,expires_at)
    SELECT a.token_id,replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),
      p_tenant_id,p_member_id,p_quote->>'membershipYear','pending',(p_quote->>'finalCost')::numeric,p_quote->>'currency',p_quote->>'tierLabel',
      jsonb_build_object('memberStart',jsonb_build_object('version',1,'requestId',saved.id,'recordId',record_id,
        'tenantId',p_tenant_id,'memberId',p_member_id,'quote',p_quote),
        'annualCost',p_quote->'annualCost','vatAmount',p_quote->'vatAmount','vatRatePercent',p_quote->'vatRatePercent',
        'totalWithVat',p_quote->'totalWithVat','taxType',p_quote->'taxType','matchedBand',p_quote#>'{targetSnapshot,band}'),
      record_id,m.email,greatest(now(),starts::timestamptz)+interval '90 days'
    FROM member_start_payment_attachment a JOIN member m ON m.id=p_member_id AND m.tenant_id=p_tenant_id WHERE a.start_id=saved.id;
  END IF;
  $new$);
  EXECUTE d;
END $migration$;

-- Existing fixed-DD dated completeness guards are retained. Extend only the
-- explicitly versioned Start monthly-card variant, never generic fixed quotes.
DO $migration$
DECLARE t text; d text; old text; owner_scope text;
BEGIN
  -- Organisation history has no member owner and must retain its existing
  -- fixed-DD-only contract. The two member-capable tables have different
  -- physical owner columns: never reference organization_id on member history.
  FOREACH t IN ARRAY ARRAY['member_membership_history','membership_billing_agreements'] LOOP
    SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conrelid=('public.'||t)::regclass AND conname=t||'_rolling_complete_check';
    old:=$old$(commitment_snapshot ->> 'payment_method'::text) = 'direct_debit'::text$old$;
    IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Dated commitment completeness constraint drift on %',t; END IF;
    owner_scope:=CASE WHEN t='member_membership_history' THEN 'member_id IS NOT NULL'
      ELSE 'member_id IS NOT NULL AND organization_id IS NULL' END;
    d:=replace(d,old,format($new$((commitment_snapshot ->> 'payment_method') = 'direct_debit' OR
      ((commitment_snapshot ->> 'payment_method') = 'card_monthly' AND (commitment_snapshot ->> 'member_start_version') = '1'
        AND %s))$new$,owner_scope));
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,t||'_rolling_complete_check');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s',t,t||'_rolling_complete_check',d);
  END LOOP;
  SELECT pg_get_functiondef('public.enforce_rolling_membership_commitment()'::regprocedure) INTO d;
  old:=$old$c#>>'{commitment_snapshot,payment_method}' = 'direct_debit'
        AND (c->>'term_key')$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Dated commitment enforcement drift'; END IF;
  d:=replace(d,old,$new$(c#>>'{commitment_snapshot,payment_method}' = 'direct_debit'
          OR (is_member AND c#>>'{commitment_snapshot,payment_method}' = 'card_monthly'
            AND c#>>'{commitment_snapshot,member_start_version}' = '1'))
        AND (c->>'term_key')$new$);
  old:=$old$IF r->price_key IS DISTINCT FROM old_r->price_key THEN$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Rolling immutable attachment field drift'; END IF;
  d:=replace(d,old,$new$IF r->price_key IS DISTINCT FROM old_r->price_key AND NOT (
      price_key='billing_agreement_id' AND old_r->>'billing_agreement_id' IS NULL
      AND EXISTS (SELECT FROM member_membership_start s JOIN member_start_payment_attachment z ON z.start_id=s.id
        WHERE s.record_id=(r->>'id')::uuid AND z.agreement_id=(r->>'billing_agreement_id')::uuid
          AND s.tenant_id=(r->>'tenant_id')::uuid AND s.member_id=(r->>'member_id')::uuid
          AND s.quote->'commitment'=c)) THEN$new$);
  old:=$old$AND billing_agreement_id IS DISTINCT FROM $3$old$;
  -- This exact fragment is inside the dynamic overlap query. Exempt only the
  -- one history identity reserved for this already attached agreement.
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Rolling overlap identity guard drift'; END IF;
  d:=replace(d,old,$new$AND billing_agreement_id IS DISTINCT FROM $3
        AND id IS DISTINCT FROM (SELECT s.record_id FROM member_membership_start s
          JOIN member_start_payment_attachment z ON z.start_id=s.id WHERE z.agreement_id=$3)$new$);
  old:=$old$IF duration IS NULL OR (c->>'term_duration_months')::integer IS DISTINCT FROM duration$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Rolling date guard drift'; END IF;
  d:=replace(d,old,$new$IF c#>>'{commitment_snapshot,start_mode}'='fixed_date'
      AND c#>>'{commitment_snapshot,member_start_version}'='1' THEN
      expected_renewal:=make_date(extract(year from start_date)::int,
        coalesce((c#>>'{commitment_snapshot,config,membership_start_month}')::int,1),
        coalesce((c#>>'{commitment_snapshot,config,membership_start_day}')::int,1));
      IF expected_renewal<=start_date THEN expected_renewal:=(expected_renewal+interval '1 year')::date; END IF;
    END IF;
    IF duration IS NULL OR (c->>'term_duration_months')::integer IS DISTINCT FROM duration$new$);
  EXECUTE d;
END $migration$;
-- Manual approval remains the existing audited finance RPC. Put its marker in
-- the same transaction after all existing eligibility checks, before activation.
-- Read-only DEST inspection found the canonical DD RPC absent at ALL
-- signatures (not an overload mismatch). Install its reviewed 20260902
-- prerequisite only when absent; an existing definition retains its checks and
-- must match the guarded patch below. Never silently omit manual DD support.
DO $prerequisite$
BEGIN
  IF to_regprocedure('public.approve_manual_dd_membership_activation(uuid,uuid,text)') IS NULL THEN
    IF EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='approve_manual_dd_membership_activation') THEN
      RAISE EXCEPTION 'Unknown manual DD approval signature; review the deployed contract';
    END IF;
    EXECUTE $definition$
CREATE FUNCTION public.approve_manual_dd_membership_activation(
  p_tenant_id UUID,
  p_plan_id UUID,
  p_actor_email TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan membership_payment_plans%ROWTYPE;
  v_agreement membership_billing_agreements%ROWTYPE;
  v_history_id UUID;
  v_history_status TEXT;
  v_history_kind TEXT;
BEGIN
  SELECT *
    INTO v_plan
    FROM membership_payment_plans
   WHERE id = p_plan_id
     AND tenant_id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'detail', 'Plan not found');
  END IF;

  SELECT *
    INTO v_agreement
    FROM membership_billing_agreements
   WHERE id = v_plan.billing_agreement_id
     AND tenant_id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'detail', 'Billing agreement not found');
  END IF;

  IF v_plan.status IN ('payment_plan_cancelled', 'expired', 'cancelled', 'completed')
     OR v_agreement.status IN ('payment_plan_cancelled', 'expired', 'cancelled', 'completed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'terminal', 'detail', 'A cancelled or expired membership cannot be activated');
  END IF;

  IF v_agreement.metadata #>> '{dd,kind}' IS DISTINCT FROM 'monthly_direct_debit'
     OR v_agreement.metadata #>> '{dd,activation_rule}' IS DISTINCT FROM 'manual' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_manual', 'detail', 'This agreement does not require manual activation');
  END IF;

  IF v_agreement.member_id IS NOT NULL THEN
    v_history_kind := 'member';
    SELECT id, status
      INTO v_history_id, v_history_status
      FROM member_membership_history
     WHERE billing_agreement_id = v_agreement.id
       AND tenant_id = p_tenant_id
     FOR UPDATE;
  ELSIF v_agreement.organization_id IS NOT NULL THEN
    v_history_kind := 'organisation';
    SELECT id, status
      INTO v_history_id, v_history_status
      FROM organisation_membership_history
     WHERE billing_agreement_id = v_agreement.id
       AND tenant_id = p_tenant_id
     FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'detail', 'Agreement has no linked membership owner');
  END IF;

  IF v_history_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'detail', 'No membership history row is linked to this agreement');
  END IF;

  IF v_history_status = 'active' THEN
    RETURN jsonb_build_object('ok', true, 'updated', false, 'already_active', true, 'detail', 'Membership is already active');
  END IF;

  IF v_history_status IS DISTINCT FROM 'pending_activation' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_status',
      'detail', format('Membership is %s, not pending activation', COALESCE(v_history_status, 'missing status'))
    );
  END IF;

  IF v_history_kind = 'member' THEN
    UPDATE member_membership_history
       SET status = 'active'
     WHERE id = v_history_id
       AND tenant_id = p_tenant_id
       AND status = 'pending_activation';
  ELSE
    UPDATE organisation_membership_history
       SET status = 'active'
     WHERE id = v_history_id
       AND tenant_id = p_tenant_id
       AND status = 'pending_activation';
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'concurrent_update', 'detail', 'Membership changed before approval could be applied');
  END IF;

  INSERT INTO membership_dd_admin_actions (
    tenant_id,
    plan_id,
    billing_agreement_id,
    action,
    actor_email,
    details
  ) VALUES (
    p_tenant_id,
    v_plan.id,
    v_agreement.id,
    'manual_activate',
    p_actor_email,
    jsonb_build_object('history_id', v_history_id, 'history_kind', v_history_kind, 'from_status', v_history_status, 'to_status', 'active')
  );

  RETURN jsonb_build_object('ok', true, 'updated', true, 'activated', true, 'detail', 'Membership activated');
END;
$$;
    $definition$;
  END IF;
END $prerequisite$;
DO $migration$
DECLARE d text; old text;
BEGIN
  SELECT pg_get_functiondef('public.approve_manual_dd_membership_activation(uuid,uuid,text)'::regprocedure) INTO d;
  old:=$old$IF v_history_kind = 'member' THEN
    UPDATE member_membership_history$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Manual DD approval guard drift'; END IF;
  d:=replace(d,old,$new$IF EXISTS (SELECT FROM member_start_payment_attachment WHERE agreement_id=v_agreement.id) THEN
    UPDATE membership_billing_agreements SET metadata=coalesce(metadata,'{}'::jsonb)||
      jsonb_build_object('member_start_manual_activation',jsonb_build_object('approved_at',now(),'actor',p_actor_email))
      WHERE id=v_agreement.id AND tenant_id=p_tenant_id;
  END IF;
  IF v_history_kind = 'member' THEN
    UPDATE member_membership_history$new$);
  EXECUTE d;
  SELECT pg_get_functiondef('public.approve_manual_card_membership_activation(uuid,uuid,uuid,text)'::regprocedure) INTO d;
  old:=$old$next_status := CASE WHEN h.term_start_date > CURRENT_DATE THEN 'scheduled' ELSE 'active' END;$old$;
  IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Manual card approval guard drift'; END IF;
  d:=replace(d,old,$new$IF EXISTS (SELECT FROM member_start_payment_attachment WHERE agreement_id=a.id) THEN
    UPDATE membership_billing_agreements SET metadata=coalesce(metadata,'{}'::jsonb)||
      jsonb_build_object('member_start_manual_activation',jsonb_build_object('approved_at',now(),'actor',p_actor_email))
      WHERE id=a.id AND tenant_id=p_tenant_id;
  END IF;
  next_status := CASE WHEN h.term_start_date > CURRENT_DATE THEN 'scheduled' ELSE 'active' END;$new$);
  EXECUTE d;
END $migration$;
REVOKE ALL ON FUNCTION public.approve_manual_dd_membership_activation(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.approve_manual_dd_membership_activation(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.member_start_attachment_write(text,text,jsonb,jsonb,uuid),
 public.member_start_monthly_activation(jsonb,uuid),public.attach_member_start_agreement(uuid,uuid),
 public.member_start_payment_delete_fence() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.attach_member_start_agreement(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.member_start_payment_capabilities() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_start_payment_capabilities() TO service_role;
COMMIT;
