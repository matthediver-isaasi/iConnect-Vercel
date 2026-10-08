-- Staged only: apply after the accounting queue and preparation migrations.
-- No backfill. Browser roles cannot read or mutate frozen financial authority.
BEGIN;
CREATE TABLE IF NOT EXISTS public.training_fund_accounting_operation (
  purchase_id uuid PRIMARY KEY REFERENCES public.training_fund_purchase(id),
  tenant_id uuid NOT NULL, member_id uuid NOT NULL, organization_id uuid NOT NULL,
  request_key uuid NOT NULL, amount numeric NOT NULL CHECK(amount > 0),
  payment_method text NOT NULL CHECK(payment_method IN ('card','invoice')),
  purchase_order_number text, po_to_follow boolean NOT NULL,
  authority jsonb NOT NULL, pending_recorded_at timestamptz, stripe_started_at timestamptz, stripe_binding text,
  UNIQUE(tenant_id,member_id,request_key)
);
ALTER TABLE public.training_fund_accounting_operation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_fund_accounting_operation FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.training_fund_accounting_operation TO service_role;

CREATE OR REPLACE FUNCTION public.guard_training_fund_accounting_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM training_fund_accounting_operation WHERE purchase_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Accepted training fund purchase cannot be deleted'; END IF;
   IF ROW(NEW.id,NEW.tenant_id,NEW.organization_id,NEW.amount,NEW.payment_method,NEW.created_by)
     IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.organization_id,OLD.amount,OLD.payment_method,OLD.created_by)
   THEN RAISE EXCEPTION 'Accepted training fund authority is immutable'; END IF;
   -- The existing pending-PO service may supply a missing PO after linkage.
   -- It cannot clear/replace an existing PO or reopen a fulfilled promise.
   -- Frozen accounting authority and retry identity retain original inputs.
   IF ROW(NEW.purchase_order_number,NEW.po_to_follow)
      IS DISTINCT FROM ROW(OLD.purchase_order_number,OLD.po_to_follow)
     AND NOT (coalesce(trim(OLD.purchase_order_number),'')=''
       AND coalesce(trim(NEW.purchase_order_number),'')<>'' AND NEW.po_to_follow=false
       AND coalesce(OLD.accounting_invoice_id,OLD.xero_invoice_id) IS NOT NULL)
   THEN RAISE EXCEPTION 'Only missing PO fulfilment is permitted'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_training_fund_accounting_source ON public.training_fund_purchase;
CREATE TRIGGER guard_training_fund_accounting_source BEFORE UPDATE OR DELETE ON public.training_fund_purchase
 FOR EACH ROW EXECUTE FUNCTION public.guard_training_fund_accounting_source();
REVOKE ALL ON FUNCTION public.guard_training_fund_accounting_source() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.accept_training_fund_accounting(
 p_tenant uuid,p_member uuid,p_org uuid,p_key uuid,p_amount numeric,p_method text,
 p_po text,p_po_later boolean,p_authority jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o training_fund_accounting_operation; pid uuid;
BEGIN
 IF p_tenant IS NULL OR p_member IS NULL OR p_org IS NULL OR p_key IS NULL
   OR p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount,2)
   OR p_method IS NULL OR p_method NOT IN ('card','invoice') OR p_po_later IS NULL
 THEN RAISE EXCEPTION 'Invalid training fund purchase'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||p_member::text||p_key::text,0));
 SELECT * INTO o FROM training_fund_accounting_operation
 WHERE tenant_id=p_tenant AND member_id=p_member AND request_key=p_key;
 IF FOUND THEN
   IF ROW(o.organization_id,o.amount,o.payment_method,o.purchase_order_number,o.po_to_follow)
      IS DISTINCT FROM ROW(p_org,p_amount,p_method,p_po,p_po_later)
   THEN RAISE EXCEPTION 'Checkout request already has different purchase details'; END IF;
   RETURN to_jsonb(o);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_member AND tenant_id=p_tenant AND organization_id=p_org)
   OR NOT EXISTS(SELECT 1 FROM organization WHERE id=p_org AND tenant_id=p_tenant)
   OR coalesce(p_authority->>'provider','') NOT IN ('xero','quickbooks')
   OR coalesce(p_authority->>'connectionId','')='' OR coalesce(p_authority->>'companyId','')=''
   OR p_authority->'invoice'->'args'->>'appTenantId' IS DISTINCT FROM p_tenant::text
   OR (p_authority->'invoice'->>'totalMinor')::numeric IS DISTINCT FROM p_amount*100
 THEN RAISE EXCEPTION 'Invalid training fund authority'; END IF;
 INSERT INTO training_fund_purchase(tenant_id,organization_id,amount,payment_method,purchase_order_number,po_to_follow,created_by)
 VALUES(p_tenant,p_org,p_amount,p_method,p_po,p_po_later,p_member) RETURNING id INTO pid;
 INSERT INTO training_fund_accounting_operation(purchase_id,tenant_id,member_id,organization_id,request_key,
 amount,payment_method,purchase_order_number,po_to_follow,authority)
 VALUES(pid,p_tenant,p_member,p_org,p_key,p_amount,p_method,p_po,p_po_later,p_authority) RETURNING * INTO o;
 PERFORM accounting_request_enqueue(p_tenant,p_authority->>'provider',p_authority->>'connectionId',
   p_authority->>'companyId','training_fund_purchase',pid::text,'invoice',
   jsonb_build_object('version',1,'preparation',true,'environment',p_authority->'environment',
     'invoice',p_authority->'invoice','payment',NULL,
     'linkage',jsonb_build_object('purchaseId',pid,'organizationId',p_org)));
 RETURN to_jsonb(o);
END $$;

-- Link and pending increment share the same purchase lock as paid-credit CAS.
-- A reconciler cannot see the invoice before its pending balance is recorded.
CREATE OR REPLACE FUNCTION public.link_training_fund_accounting(p_tenant uuid,p_purchase uuid,
 p_provider text,p_invoice text,p_number text,p_url text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p training_fund_purchase; o training_fund_accounting_operation;
BEGIN
 SELECT * INTO p FROM training_fund_purchase WHERE id=p_purchase AND tenant_id=p_tenant FOR UPDATE;
 SELECT * INTO o FROM training_fund_accounting_operation WHERE purchase_id=p_purchase AND tenant_id=p_tenant FOR UPDATE;
 IF p.id IS NULL OR o.purchase_id IS NULL OR p.organization_id<>o.organization_id
   OR p.amount<>o.amount OR p.payment_method<>o.payment_method
   OR p_provider IS DISTINCT FROM o.authority->>'provider' OR coalesce(p_invoice,'')=''
   OR (p.accounting_invoice_id IS NOT NULL AND p.accounting_invoice_id<>p_invoice)
   OR (p.xero_invoice_id IS NOT NULL AND (p_provider<>'xero' OR p.xero_invoice_id<>p_invoice))
   OR (p.accounting_provider IS NOT NULL AND p.accounting_provider<>p_provider)
   OR NOT EXISTS(SELECT 1 FROM accounting_request_queue q WHERE q.tenant_id=p_tenant
      AND q.source_type='training_fund_purchase' AND q.source_id=p_purchase::text
      AND q.connection_id=o.authority->>'connectionId' AND q.company_id=o.authority->>'companyId'
      AND q.provider=p_provider AND q.invoice_status='done' AND q.invoice_result->>'id'=p_invoice)
 THEN RAISE EXCEPTION 'Training fund invoice authority mismatch'; END IF;
 IF o.pending_recorded_at IS NULL AND p.payment_method='invoice' AND p.status='pending' THEN
   UPDATE organization SET training_fund_pending_balance=coalesce(training_fund_pending_balance,0)+p.amount
   WHERE id=p.organization_id AND tenant_id=p_tenant;
   IF NOT FOUND THEN RAISE EXCEPTION 'Organisation missing'; END IF;
   UPDATE training_fund_accounting_operation SET pending_recorded_at=now() WHERE purchase_id=p_purchase;
 END IF;
 UPDATE training_fund_purchase SET accounting_provider=p_provider,accounting_invoice_id=p_invoice,
 accounting_invoice_number=p_number,online_invoice_url=p_url,
 xero_invoice_id=CASE WHEN p_provider='xero' THEN p_invoice ELSE xero_invoice_id END,
 xero_invoice_number=CASE WHEN p_provider='xero' THEN p_number ELSE xero_invoice_number END
 WHERE id=p_purchase;
 RETURN jsonb_build_object('linked',true,'purchaseId',p_purchase);
END $$;

CREATE OR REPLACE FUNCTION public.start_training_fund_card_setup(p_tenant uuid,p_purchase uuid,p_binding text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p training_fund_purchase; o training_fund_accounting_operation;
BEGIN
 SELECT * INTO p FROM training_fund_purchase WHERE id=p_purchase AND tenant_id=p_tenant FOR UPDATE;
 SELECT * INTO o FROM training_fund_accounting_operation WHERE purchase_id=p_purchase AND tenant_id=p_tenant FOR UPDATE;
 IF p.id IS NULL OR o.purchase_id IS NULL OR p.payment_method<>'card'
   OR p.amount<>o.amount OR p.organization_id<>o.organization_id OR p.accounting_invoice_id IS NULL
   OR coalesce(p_binding,'')='' OR (o.stripe_binding IS NOT NULL AND o.stripe_binding<>p_binding)
 THEN RAISE EXCEPTION 'Card setup not ready'; END IF;
 UPDATE training_fund_accounting_operation SET stripe_started_at=coalesce(stripe_started_at,now()),
 stripe_binding=coalesce(stripe_binding,p_binding)
 WHERE purchase_id=p_purchase RETURNING * INTO o;
 RETURN jsonb_build_object('started_at',o.stripe_started_at,'intent_id',p.stripe_payment_intent_id,'status',p.status);
END $$;

CREATE OR REPLACE FUNCTION public.bind_training_fund_card_setup(p_tenant uuid,p_purchase uuid,p_intent text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p training_fund_purchase;
BEGIN
 SELECT * INTO p FROM training_fund_purchase WHERE id=p_purchase AND tenant_id=p_tenant FOR UPDATE;
 IF p.id IS NULL OR p.payment_method<>'card' OR coalesce(p_intent,'')=''
   OR NOT EXISTS(SELECT 1 FROM training_fund_accounting_operation WHERE purchase_id=p_purchase
      AND tenant_id=p_tenant AND stripe_started_at IS NOT NULL)
   OR (p.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id<>p_intent)
 THEN RAISE EXCEPTION 'Card setup identity mismatch'; END IF;
 UPDATE training_fund_purchase SET stripe_payment_intent_id=p_intent WHERE id=p_purchase;
 RETURN jsonb_build_object('bound',true);
END $$;
REVOKE ALL ON FUNCTION public.accept_training_fund_accounting(uuid,uuid,uuid,uuid,numeric,text,text,boolean,jsonb),
 public.link_training_fund_accounting(uuid,uuid,text,text,text,text),
 public.start_training_fund_card_setup(uuid,uuid,text), public.bind_training_fund_card_setup(uuid,uuid,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accept_training_fund_accounting(uuid,uuid,uuid,uuid,numeric,text,text,boolean,jsonb),
 public.link_training_fund_accounting(uuid,uuid,text,text,text,text),
 public.start_training_fund_card_setup(uuid,uuid,text), public.bind_training_fund_card_setup(uuid,uuid,text)
 TO service_role;
COMMIT;
