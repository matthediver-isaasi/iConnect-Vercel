BEGIN;
CREATE TABLE public.form_initial_checkout_recovery(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 state text NOT NULL CHECK(state IN ('reconciling','released','refused')),
 snapshot jsonb NOT NULL, receipts jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);
CREATE UNIQUE INDEX form_initial_checkout_recovery_open ON public.form_initial_checkout_recovery(tenant_id,member_id)
 WHERE state='reconciling';
ALTER TABLE public.form_initial_checkout_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_initial_checkout_recovery FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.form_initial_checkout_recovery TO service_role;
CREATE POLICY initial_recovery_service_read ON public.form_initial_checkout_recovery FOR SELECT TO service_role USING(true);

CREATE FUNCTION public.begin_form_initial_checkout_recovery(p_tenant_id uuid,p_member_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.form_initial_checkout_recovery; qs jsonb; agreements jsonb; histories jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id AND NOT coalesce(membership_paused,false)) THEN
  RAISE EXCEPTION 'Member unavailable'; END IF;
 SELECT * INTO op FROM public.form_initial_checkout_recovery WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND state='reconciling' FOR UPDATE;
 IF FOUND THEN RETURN op.snapshot||jsonb_build_object('recoveryId',op.id); END IF;
 IF EXISTS(SELECT 1 FROM public.form_joining_voucher_checkout WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND released_at IS NULL) THEN
  RAISE EXCEPTION 'Return to the saved credit checkout to release its credit first'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO qs FROM public.membership_payment_quote x
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND organization_id IS NULL AND cancelled_for_switch_at IS NULL;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO agreements FROM public.membership_billing_agreements x
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND organization_id IS NULL AND cancelled_for_switch_at IS NULL
    AND status NOT IN ('cancelled','completed','expired');
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO histories FROM public.member_membership_history x
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND cancelled_for_switch_at IS NULL
    AND status NOT IN ('cancelled','canceled','void','expired_checkout');
 IF jsonb_array_length(qs)+jsonb_array_length(agreements)=0 THEN RAISE EXCEPTION 'No unfinished checkout was found'; END IF;
 IF jsonb_array_length(qs)>1 OR jsonb_array_length(agreements)>1 OR jsonb_array_length(histories)>1 THEN
  RAISE EXCEPTION 'Conflicting checkout evidence requires review'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(qs) q WHERE q#>>'{quote,simResult,formRenewalElectionId}' IS NOT NULL
    OR q->>'stripe_payment_intent_id' IS NULL)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(agreements) a WHERE a->>'membership_successor_election_id' IS NOT NULL
    OR a->>'status' IS DISTINCT FROM 'payment_setup_required'
    OR a->>'gocardless_mandate_id' IS NOT NULL OR a->>'gocardless_subscription_id' IS NOT NULL
    OR a->>'stripe_subscription_id' IS NOT NULL OR a->>'previous_term_id' IS NOT NULL
    OR a->>'provider' NOT IN ('stripe','gocardless')
    OR (a->>'provider'='stripe' AND a->>'stripe_checkout_session_id' IS NULL)
    OR (a->>'provider'='gocardless' AND a->>'gocardless_billing_request_id' IS NULL)
    OR EXISTS(SELECT 1 FROM public.membership_payment_plans p WHERE p.billing_agreement_id::text=a->>'id'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(histories) h WHERE h->>'status' IS DISTINCT FROM 'pending_payment_setup'
    OR h->>'payment_status' IS DISTINCT FROM 'unpaid' OR h->>'paid_at' IS NOT NULL
    OR h->>'previous_term_id' IS NOT NULL OR h->>'membership_successor_election_id' IS NOT NULL
    OR h->>'stripe_payment_intent_id' IS NOT NULL OR h->>'xero_invoice_id' IS NOT NULL
    OR h->>'accounting_invoice_id' IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(agreements) a WHERE a->>'id'=h->>'billing_agreement_id')) THEN
  RAISE EXCEPTION 'An authorized or unresolved payment cannot be released'; END IF;
 INSERT INTO public.form_initial_checkout_recovery(tenant_id,member_id,state,snapshot)
 VALUES(p_tenant_id,p_member_id,'reconciling',jsonb_build_object('quotes',qs,'agreements',agreements,'histories',histories))
 RETURNING * INTO op;
 RETURN op.snapshot||jsonb_build_object('recoveryId',op.id);
END $$;

CREATE FUNCTION public.finish_form_initial_checkout_recovery(p_tenant_id uuid,p_member_id uuid,p_recovery_id uuid,p_receipts jsonb,p_refused boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.form_initial_checkout_recovery; expected text[]; received text[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 SELECT * INTO op FROM public.form_initial_checkout_recovery WHERE id=p_recovery_id AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Checkout owner mismatch'; END IF;
 IF op.state='released' THEN RETURN true; END IF;
 IF op.state<>'reconciling' THEN RAISE EXCEPTION 'Checkout is not being reconciled'; END IF;
 IF p_refused THEN
  UPDATE public.form_initial_checkout_recovery SET state='refused' WHERE id=op.id;
  RETURN false;
 END IF;
 IF jsonb_typeof(p_receipts) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_receipts) r WHERE r->>'status' IS DISTINCT FROM 'canceled') THEN
  RAISE EXCEPTION 'Confirmed provider cancellation is required'; END IF;
 SELECT array_agg(id ORDER BY id) INTO expected FROM (
  SELECT q->>'stripe_payment_intent_id' id FROM jsonb_array_elements(op.snapshot->'quotes') q
  UNION ALL SELECT CASE WHEN a->>'provider'='stripe' THEN a->>'stripe_checkout_session_id' ELSE a->>'gocardless_billing_request_id' END
  FROM jsonb_array_elements(op.snapshot->'agreements') a) ids;
 SELECT array_agg(r->>'id' ORDER BY r->>'id') INTO received FROM jsonb_array_elements(p_receipts) r;
 IF expected IS DISTINCT FROM received THEN RAISE EXCEPTION 'Incomplete cancellation receipts'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(op.snapshot->'quotes') q WHERE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(p_receipts) r WHERE r->>'id'=q->>'stripe_payment_intent_id'
   AND (r->>'livemode')::boolean IS NOT DISTINCT FROM (q#>>'{quote,stripeEnvironment}'='live')))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(op.snapshot->'agreements') a WHERE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(p_receipts) r WHERE r->>'id'=CASE WHEN a->>'provider'='stripe' THEN a->>'stripe_checkout_session_id' ELSE a->>'gocardless_billing_request_id' END
   AND r->>'environment'=a->>'environment')) THEN RAISE EXCEPTION 'Provider environment mismatch'; END IF;
 UPDATE public.membership_payment_quote SET cancelled_for_switch_at=now()
  WHERE id IN(SELECT (q->>'id')::uuid FROM jsonb_array_elements(op.snapshot->'quotes') q);
 UPDATE public.member_membership_history SET status='expired_checkout',cancelled_for_switch_at=now()
  WHERE id IN(SELECT (h->>'id')::uuid FROM jsonb_array_elements(op.snapshot->'histories') h);
 UPDATE public.membership_billing_agreements SET status='cancelled',cancelled_for_switch_at=now()
  WHERE id IN(SELECT (a->>'id')::uuid FROM jsonb_array_elements(op.snapshot->'agreements') a);
 DELETE FROM public.membership_payment_term_claim c WHERE c.tenant_id=p_tenant_id AND c.owner_type='member' AND c.owner_id=p_member_id
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(op.snapshot->'agreements') a WHERE c.source_key=a->>'idempotency_key');
 UPDATE public.form_initial_checkout_recovery SET state='released',receipts=p_receipts,released_at=now() WHERE id=op.id;
 RETURN true;
END $$;

CREATE FUNCTION public.guard_form_initial_checkout_recovery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb:=to_jsonb(NEW); oldr jsonb; op public.form_initial_checkout_recovery; section text; generation text;
BEGIN
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.form_initial_checkout_recovery
    WHERE tenant_id=(to_jsonb(OLD)->>'tenant_id')::uuid AND member_id=(to_jsonb(OLD)->>'member_id')::uuid)
   AND (to_jsonb(OLD)->>'tenant_id' IS DISTINCT FROM r->>'tenant_id'
    OR to_jsonb(OLD)->>'member_id' IS DISTINCT FROM r->>'member_id'
    OR to_jsonb(OLD)->>'organization_id' IS DISTINCT FROM r->>'organization_id') THEN
  RAISE EXCEPTION 'Checkout ownership is immutable'; END IF;
 IF r->>'member_id' IS NULL OR r->>'organization_id' IS NOT NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||(r->>'tenant_id')||':member_id:'||(r->>'member_id'),0));
 section:=CASE TG_TABLE_NAME WHEN 'membership_payment_quote' THEN 'quotes' WHEN 'membership_billing_agreements' THEN 'agreements' ELSE 'histories' END;
 SELECT * INTO op FROM public.form_initial_checkout_recovery WHERE tenant_id=(r->>'tenant_id')::uuid AND member_id=(r->>'member_id')::uuid
  AND (state='reconciling' OR (state='released' AND (
    EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->section) x WHERE x->>'id'=r->>'id')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'agreements') x WHERE x->>'id'=r->>'billing_agreement_id')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'quotes') x WHERE x->>'id'=r->>'membership_payment_quote_id'))))
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
 IF FOUND THEN
  IF TG_OP='UPDATE' THEN
   oldr:=to_jsonb(OLD);
   IF op.state='reconciling' AND oldr->>'cancelled_for_switch_at' IS NULL AND r->>'cancelled_for_switch_at' IS NOT NULL
    AND (r-'cancelled_for_switch_at'-'status')=(oldr-'cancelled_for_switch_at'-'status')
    AND (TG_TABLE_NAME='membership_payment_quote' OR r->>'status'=CASE WHEN TG_TABLE_NAME='membership_billing_agreements' THEN 'cancelled' ELSE 'expired_checkout' END)
    THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'First checkout is being reconciled or has been released';
 END IF;
 IF TG_OP='INSERT' AND TG_TABLE_NAME IN ('membership_payment_quote','membership_billing_agreements','form_joining_voucher_checkout') THEN
  SELECT * INTO op FROM public.form_initial_checkout_recovery WHERE tenant_id=(r->>'tenant_id')::uuid AND member_id=(r->>'member_id')::uuid AND state='released'
   ORDER BY released_at DESC LIMIT 1;
  IF FOUND AND r->>'membership_successor_election_id' IS NULL AND r#>>'{quote,simResult,formRenewalElectionId}' IS NULL THEN
   generation:=CASE TG_TABLE_NAME WHEN 'membership_payment_quote' THEN r#>>'{quote,simResult,initialRecoveryGeneration}'
    WHEN 'form_joining_voucher_checkout' THEN r#>>'{breakdown,formJoiningVoucher,simulation,initialRecoveryGeneration}'
    ELSE r#>>'{metadata,initialRecoveryGeneration}' END;
   IF generation IS DISTINCT FROM op.id::text AND NOT EXISTS(
    SELECT 1 FROM public.membership_voucher_settlement s
    JOIN public.membership_fee_token t ON t.id=s.fee_token_id
    WHERE s.tenant_id=op.tenant_id AND t.member_id=op.member_id
     AND s.id::text=coalesce(r#>>'{metadata,dd,voucher_funding,settlement_id}',r#>>'{metadata,card,voucher_funding,settlement_id}')
     AND t.cost_breakdown#>>'{formJoiningVoucher,simulation,initialRecoveryGeneration}'=op.id::text
   ) THEN RAISE EXCEPTION 'Refresh payment choices after the previous checkout was released'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_initial_recovery BEFORE INSERT OR UPDATE ON public.membership_payment_quote FOR EACH ROW EXECUTE FUNCTION public.guard_form_initial_checkout_recovery();
CREATE TRIGGER guard_initial_recovery BEFORE INSERT OR UPDATE ON public.membership_billing_agreements FOR EACH ROW EXECUTE FUNCTION public.guard_form_initial_checkout_recovery();
CREATE TRIGGER guard_initial_recovery BEFORE INSERT OR UPDATE ON public.member_membership_history FOR EACH ROW EXECUTE FUNCTION public.guard_form_initial_checkout_recovery();
CREATE TRIGGER guard_initial_recovery BEFORE INSERT ON public.form_joining_voucher_checkout FOR EACH ROW EXECUTE FUNCTION public.guard_form_initial_checkout_recovery();
REVOKE ALL ON FUNCTION public.begin_form_initial_checkout_recovery(uuid,uuid),public.finish_form_initial_checkout_recovery(uuid,uuid,uuid,jsonb,boolean),public.guard_form_initial_checkout_recovery() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_form_initial_checkout_recovery(uuid,uuid),public.finish_form_initial_checkout_recovery(uuid,uuid,uuid,jsonb,boolean) TO service_role;
COMMIT;
