BEGIN;
-- Some live schemas retain the original unconditional year constraint alongside
-- the newer partial indexes. Both it and the later overlap constraint must
-- release retired checkouts, without weakening either rule for live purchases.
DO $$
DECLARE definition text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid='public.member_membership_history'::regclass
   AND conname='member_membership_history_tenant_id_member_id_membership_ye_key';
 IF definition IS DISTINCT FROM 'UNIQUE (tenant_id, member_id, membership_year)' THEN
  RAISE EXCEPTION 'Unexpected membership year constraint; review schema before installation'; END IF;
 ALTER TABLE public.member_membership_history DROP CONSTRAINT member_membership_history_tenant_id_member_id_membership_ye_key;
 CREATE UNIQUE INDEX member_membership_history_live_year_uniq
  ON public.member_membership_history(tenant_id,member_id,membership_year) WHERE cancelled_for_switch_at IS NULL;
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid='public.member_membership_history'::regclass AND conname='member_membership_history_rolling_no_overlap';
 IF definition IS NULL OR definition NOT LIKE 'EXCLUDE USING gist (tenant_id WITH =, member_id WITH =, daterange(term_start_date, membership_renewal_date,%'
  OR position(' WHERE (' IN definition)=0 OR position('cancelled_for_switch_at' IN definition)>0 THEN
  RAISE EXCEPTION 'Unexpected membership overlap constraint; review schema before installation'; END IF;
 ALTER TABLE public.member_membership_history DROP CONSTRAINT member_membership_history_rolling_no_overlap;
 EXECUTE 'ALTER TABLE public.member_membership_history ADD CONSTRAINT member_membership_history_rolling_no_overlap '
  ||replace(definition,' WHERE (',' WHERE ((cancelled_for_switch_at IS NULL) AND ');
END $$;
-- Permit the accounting-backed void only while its private recovery journal
-- holds the verified receipt. Ordinary provider recovery retains its contract.
DO $$
DECLARE definition text; needle text:=$needle$AND (r-'cancelled_for_switch_at'-'status')=(oldr-'cancelled_for_switch_at'-'status')$needle$;
BEGIN
 SELECT pg_get_functiondef('public.guard_form_initial_checkout_recovery()'::regprocedure) INTO definition;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'Initial checkout guard changed; review before installation'; END IF;
 EXECUTE replace(definition,needle,$replacement$AND (
  (r-'cancelled_for_switch_at'-'status')=(oldr-'cancelled_for_switch_at'-'status')
  OR (TG_TABLE_NAME='member_membership_history' AND op.snapshot ? 'adminUnpaidCancellation'
   AND op.receipts#>>'{invoice,status}'='VOIDED' AND r->>'payment_status'='voided'
   AND (r-'cancelled_for_switch_at'-'status'-'payment_status')=(oldr-'cancelled_for_switch_at'-'status'-'payment_status'))
 )$replacement$);
END $$;
-- Reuse first-checkout fencing and generation authority, but do not let the
-- member-facing recovery endpoint release an invoice without accounting proof.
ALTER FUNCTION public.finish_form_initial_checkout_recovery(uuid,uuid,uuid,jsonb,boolean)
 RENAME TO finish_form_initial_checkout_recovery_internal;
REVOKE ALL ON FUNCTION public.finish_form_initial_checkout_recovery_internal(uuid,uuid,uuid,jsonb,boolean)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.finish_form_initial_checkout_recovery(
 p_tenant_id uuid,p_member_id uuid,p_recovery_id uuid,p_receipts jsonb,p_refused boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 IF EXISTS(SELECT 1 FROM public.form_initial_checkout_recovery
  WHERE id=p_recovery_id AND tenant_id=p_tenant_id AND member_id=p_member_id
   AND snapshot ? 'adminUnpaidCancellation') THEN
  RAISE EXCEPTION 'Administrator invoice cancellation must be reconciled first';
 END IF;
 RETURN public.finish_form_initial_checkout_recovery_internal(p_tenant_id,p_member_id,p_recovery_id,p_receipts,p_refused);
END $$;

CREATE FUNCTION public.begin_admin_unpaid_membership_cancellation(
 p_tenant_id uuid,p_member_id uuid,p_actor_id uuid,p_history jsonb,p_invoice jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.form_initial_checkout_recovery; h public.member_membership_history; owner jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 IF p_actor_id IS NULL OR length(trim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 1000 THEN
  RAISE EXCEPTION 'An administrator audit identity and reason are required'; END IF;
 SELECT * INTO op FROM public.form_initial_checkout_recovery
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND state='reconciling' FOR UPDATE;
 IF FOUND THEN
  IF NOT op.snapshot ? 'adminUnpaidCancellation' THEN RAISE EXCEPTION 'Another checkout recovery is in progress'; END IF;
  RETURN to_jsonb(op);
 END IF;
 SELECT to_jsonb(m) INTO owner FROM public.member m WHERE id=p_member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF owner IS NULL OR coalesce((owner->>'membership_paused')::boolean,false)
  OR coalesce((owner->>'membership_cancelled')::boolean,false) OR owner->>'organization_id' IS NOT NULL THEN
  RAISE EXCEPTION 'Only an available individual member can restart joining'; END IF;
 SELECT * INTO h FROM public.member_membership_history
  WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND id=(p_history->>'id')::uuid FOR UPDATE;
 IF NOT FOUND OR to_jsonb(h) IS DISTINCT FROM p_history THEN RAISE EXCEPTION 'Membership changed; preview again'; END IF;
 IF h.status IS DISTINCT FROM 'pending_payment_setup' OR h.payment_status IS DISTINCT FROM 'unpaid'
  OR h.payment_method IS DISTINCT FROM 'invoice' OR h.paid_at IS NOT NULL OR h.cancelled_for_switch_at IS NOT NULL
  OR h.billing_agreement_id IS NOT NULL OR h.membership_payment_quote_id IS NOT NULL
  OR h.previous_term_id IS NOT NULL OR h.membership_successor_election_id IS NOT NULL
  OR h.stripe_payment_intent_id IS NOT NULL
  OR coalesce(to_jsonb(h)#>>'{commitment_snapshot,payment_frequency}','upfront')<>'upfront'
  OR coalesce(to_jsonb(h)->>'accounting_provider','xero')<>'xero'
  OR coalesce(h.accounting_invoice_id,h.xero_invoice_id)::text IS DISTINCT FROM p_invoice->>'id'
  OR (h.accounting_invoice_id IS NOT NULL AND h.xero_invoice_id IS NOT NULL
   AND h.accounting_invoice_id IS DISTINCT FROM h.xero_invoice_id)
  OR jsonb_typeof(p_invoice) IS DISTINCT FROM 'object'
  OR nullif(p_invoice->>'id','') IS NULL OR nullif(p_invoice->>'providerTenantId','') IS NULL
  OR nullif(p_invoice->>'contactId','') IS NULL OR p_invoice->>'status' IS DISTINCT FROM 'AUTHORISED'
  OR (p_invoice->>'paidMinor')::bigint IS DISTINCT FROM 0
  OR (p_invoice->>'creditedMinor')::bigint IS DISTINCT FROM 0
  OR (p_invoice->>'grossMinor')::bigint IS DISTINCT FROM round((to_jsonb(h)->>'total_with_vat')::numeric*100)::bigint
  OR (p_invoice->>'dueMinor')::bigint IS DISTINCT FROM (p_invoice->>'grossMinor')::bigint THEN
  RAISE EXCEPTION 'Only an original unpaid invoice purchase can be cancelled here'; END IF;
 -- Do not promise portal re-entry while another purchase, credit reservation or
 -- payment rail exists. These cases require their own financial review.
 IF EXISTS(SELECT 1 FROM public.member_membership_history
   WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND id<>h.id AND cancelled_for_switch_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.membership_billing_agreements
   WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND cancelled_for_switch_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.membership_payment_quote
   WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND cancelled_for_switch_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.membership_payment_plans WHERE tenant_id=p_tenant_id AND member_id=p_member_id)
  OR EXISTS(SELECT 1 FROM public.membership_fee_token
   WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND status IN ('pending','paid','expired'))
  OR EXISTS(SELECT 1 FROM public.form_joining_voucher_checkout
   WHERE tenant_id=p_tenant_id AND member_id=p_member_id AND released_at IS NULL) THEN
  RAISE EXCEPTION 'Other payment or membership evidence requires finance review'; END IF;
 INSERT INTO public.form_initial_checkout_recovery(tenant_id,member_id,state,snapshot)
 VALUES(p_tenant_id,p_member_id,'reconciling',jsonb_build_object(
  'quotes','[]'::jsonb,'agreements','[]'::jsonb,'histories',jsonb_build_array(to_jsonb(h)),
  'adminUnpaidCancellation',jsonb_build_object('actorId',p_actor_id,'reason',trim(p_reason),'invoice',p_invoice)))
 RETURNING * INTO op;
 RETURN to_jsonb(op);
END $$;

CREATE FUNCTION public.finish_admin_unpaid_membership_cancellation(
 p_tenant_id uuid,p_member_id uuid,p_recovery_id uuid,p_actor_id uuid,p_receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.form_initial_checkout_recovery; invoice jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||p_tenant_id::text||':member_id:'||p_member_id::text,0));
 SELECT * INTO op FROM public.form_initial_checkout_recovery WHERE id=p_recovery_id
  AND tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR p_actor_id IS NULL OR NOT op.snapshot ? 'adminUnpaidCancellation' THEN
  RAISE EXCEPTION 'Owned administrator cancellation required'; END IF;
 IF op.state='released' THEN RETURN true; END IF;
 invoice:=op.snapshot#>'{adminUnpaidCancellation,invoice}';
 IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object'
  OR p_receipt->>'id' IS DISTINCT FROM invoice->>'id'
  OR p_receipt->>'providerTenantId' IS DISTINCT FROM invoice->>'providerTenantId'
  OR p_receipt->>'contactId' IS DISTINCT FROM invoice->>'contactId'
  OR p_receipt->>'currency' IS DISTINCT FROM invoice->>'currency'
  OR p_receipt->>'grossMinor' IS DISTINCT FROM invoice->>'grossMinor'
  OR p_receipt->>'status' IS DISTINCT FROM 'VOIDED'
  OR (p_receipt->>'paidMinor')::bigint IS DISTINCT FROM 0
  OR (p_receipt->>'creditedMinor')::bigint IS DISTINCT FROM 0 THEN
  RAISE EXCEPTION 'Verified unpaid invoice void is required'; END IF;
 IF op.state<>'reconciling' OR jsonb_array_length(op.snapshot->'histories')<>1
  OR op.snapshot->'quotes'<>'[]'::jsonb OR op.snapshot->'agreements'<>'[]'::jsonb THEN
  RAISE EXCEPTION 'An exclusive original invoice purchase is required'; END IF;
 UPDATE public.form_initial_checkout_recovery SET receipts=jsonb_build_object(
  'invoice',p_receipt,'completedBy',p_actor_id) WHERE id=op.id;
 UPDATE public.member_membership_history SET status='expired_checkout',payment_status='voided',cancelled_for_switch_at=now()
  WHERE id=(op.snapshot#>>'{histories,0,id}')::uuid AND tenant_id=p_tenant_id AND member_id=p_member_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'The protected original purchase is missing'; END IF;
 UPDATE public.form_initial_checkout_recovery SET state='released',released_at=now() WHERE id=op.id;
 RETURN true;
END $$;
-- The primary checkout guard fences quotes, agreements and history updates.
-- Fence the remaining local payment records and history deletion as well.
CREATE FUNCTION public.guard_admin_unpaid_cancellation_auxiliary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; op public.form_initial_checkout_recovery;
BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF r->>'member_id' IS NULL THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rolling:'||(r->>'tenant_id')||':member_id:'||(r->>'member_id'),0));
 SELECT * INTO op FROM public.form_initial_checkout_recovery
  WHERE tenant_id=(r->>'tenant_id')::uuid AND member_id=(r->>'member_id')::uuid
   AND snapshot ? 'adminUnpaidCancellation'
   AND (state='reconciling' OR (TG_TABLE_NAME='member_membership_history' AND state='released'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'histories') x WHERE x->>'id'=r->>'id')))
  LIMIT 1;
 IF FOUND THEN RAISE EXCEPTION 'Unpaid cancellation protects this purchase; reconcile it before another payment'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER guard_admin_unpaid_cancellation BEFORE DELETE ON public.member_membership_history
 FOR EACH ROW EXECUTE FUNCTION public.guard_admin_unpaid_cancellation_auxiliary();
CREATE TRIGGER guard_admin_unpaid_cancellation BEFORE INSERT OR UPDATE ON public.membership_fee_token
 FOR EACH ROW EXECUTE FUNCTION public.guard_admin_unpaid_cancellation_auxiliary();
CREATE TRIGGER guard_admin_unpaid_cancellation BEFORE INSERT OR UPDATE ON public.membership_payment_plans
 FOR EACH ROW EXECUTE FUNCTION public.guard_admin_unpaid_cancellation_auxiliary();
REVOKE ALL ON FUNCTION public.guard_admin_unpaid_cancellation_auxiliary() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.finish_form_initial_checkout_recovery(uuid,uuid,uuid,jsonb,boolean),
 public.begin_admin_unpaid_membership_cancellation(uuid,uuid,uuid,jsonb,jsonb,text),
 public.finish_admin_unpaid_membership_cancellation(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_form_initial_checkout_recovery(uuid,uuid,uuid,jsonb,boolean),
 public.begin_admin_unpaid_membership_cancellation(uuid,uuid,uuid,jsonb,jsonb,text),
 public.finish_admin_unpaid_membership_cancellation(uuid,uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
