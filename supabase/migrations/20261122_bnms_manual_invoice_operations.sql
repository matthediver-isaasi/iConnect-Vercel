-- Separate manual cohort, never expands Alpha's exception or invoice permissions.
CREATE TABLE public.bnms_manual_invoice_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
 plan_id uuid NOT NULL REFERENCES public.membership_payment_plans(id),
 payment_id text NOT NULL UNIQUE,request_identity jsonb NOT NULL,
 claim_token uuid NOT NULL DEFAULT gen_random_uuid(),invoice_id text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),linked_at timestamptz,
 CHECK((invoice_id IS NULL)=(linked_at IS NULL))
);
ALTER TABLE public.bnms_manual_invoice_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_manual_invoice_operations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.bnms_manual_invoice_operations TO service_role;

CREATE FUNCTION public.bnms_manual_claim_invoice(p_tenant uuid,p_plan uuid,p_payment text,p_identity jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.bnms_manual_invoice_operations; inserted boolean;
BEGIN
 IF p_identity IS NULL OR NOT EXISTS(
   SELECT FROM bnms_dd_manual_adoption a JOIN bnms_dd_manual_release r ON r.adoption_id=a.id
   JOIN gocardless_payments p ON p.plan_id=a.plan_id AND p.tenant_id=a.tenant_id
   JOIN gocardless_collection_reservations c ON c.plan_id=a.plan_id AND c.tenant_id=a.tenant_id
     AND c.billing_agreement_id=a.agreement_id AND c.gocardless_payment_id=p.gocardless_payment_id
   WHERE a.tenant_id=p_tenant AND a.plan_id=p_plan AND p.gocardless_payment_id=p_payment
     AND clock_timestamp()>=r.processing_not_before
     AND a.workbook_sha256='ddbc1a3d789e17ad78d507284b7823570e2f383fd5455f1e57a6a6e962f09d2a'
     AND p.gocardless_mandate_id=a.mandate_id AND p.environment='live' AND p.status IN ('confirmed','paid_out')
     AND p.currency='GBP' AND p.amount_minor=c.amount_minor AND c.currency=p.currency AND c.due_date>='2026-10-01'
     AND p.charge_date=c.requested_charge_date
     AND (p_identity->>'amountMinor')::integer=p.amount_minor AND p_identity->>'currency'='GBP'
     AND p_identity->>'contactId'=a.evidence#>>'{accounting,contactId}'
     AND p_identity->>'xeroTenantId'=a.evidence#>>'{accounting,xeroTenantId}'
     AND p_identity->>'revenueCode'=a.evidence#>>'{accounting,revenueCode}'
     AND p_identity->>'paymentReference'='GoCardless DD: '||p_payment
     AND length(p_identity->>'idempotencyKey')>0 AND length(p_identity->>'paymentIdempotencyKey')>0
 ) THEN RAISE EXCEPTION 'Manual invoice canonical collection ownership mismatch'; END IF;
 INSERT INTO bnms_manual_invoice_operations(tenant_id,plan_id,payment_id,request_identity)
 VALUES(p_tenant,p_plan,p_payment,p_identity) ON CONFLICT(payment_id) DO NOTHING RETURNING * INTO op;
 inserted:=FOUND;
 IF NOT inserted THEN
   SELECT * INTO STRICT op FROM bnms_manual_invoice_operations WHERE payment_id=p_payment FOR UPDATE;
   IF op.tenant_id IS DISTINCT FROM p_tenant OR op.plan_id IS DISTINCT FROM p_plan OR op.request_identity IS DISTINCT FROM p_identity
   THEN RAISE EXCEPTION 'Manual invoice request identity changed'; END IF;
   IF op.invoice_id IS NULL THEN RAISE EXCEPTION 'Manual invoice outcome uncertain; never re-POST'; END IF;
 END IF;
 RETURN jsonb_build_object('id',op.id,'invoice_id',op.invoice_id,'token',CASE WHEN inserted THEN op.claim_token ELSE NULL END);
END $$;
CREATE FUNCTION public.bnms_manual_link_invoice(p_operation uuid,p_token uuid,p_invoice text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.bnms_manual_invoice_operations;
BEGIN
 IF p_invoice IS NULL OR p_invoice !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN RAISE EXCEPTION 'Manual invoice ID invalid'; END IF;
 SELECT * INTO STRICT op FROM bnms_manual_invoice_operations WHERE id=p_operation FOR UPDATE;
 IF op.claim_token IS DISTINCT FROM p_token OR (op.invoice_id IS NOT NULL AND op.invoice_id<>p_invoice)
 THEN RAISE EXCEPTION 'Manual invoice linkage owner mismatch'; END IF;
 IF op.invoice_id IS NULL THEN
   UPDATE bnms_manual_invoice_operations SET invoice_id=p_invoice,linked_at=clock_timestamp() WHERE id=op.id;
 END IF;
 RETURN jsonb_build_object('id',op.id,'invoice_id',op.invoice_id);
END $$;
CREATE FUNCTION public.bnms_manual_assert_invoice(p_tenant uuid,p_plan uuid,p_payment text,p_invoice text,p_contact text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.bnms_manual_invoice_operations;
BEGIN
 SELECT * INTO op FROM bnms_manual_invoice_operations WHERE tenant_id=p_tenant AND plan_id=p_plan AND payment_id=p_payment
   AND invoice_id=p_invoice AND request_identity->>'contactId'=p_contact;
 IF NOT FOUND THEN RAISE EXCEPTION 'Manual invoice retry lacks durable exact linkage'; END IF;
 RETURN jsonb_build_object('id',op.id,'invoice_id',op.invoice_id);
END $$;
REVOKE ALL ON FUNCTION public.bnms_manual_claim_invoice(uuid,uuid,text,jsonb),
 public.bnms_manual_link_invoice(uuid,uuid,text),
 public.bnms_manual_assert_invoice(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bnms_manual_claim_invoice(uuid,uuid,text,jsonb),
 public.bnms_manual_link_invoice(uuid,uuid,text),
 public.bnms_manual_assert_invoice(uuid,uuid,text,text,text) TO service_role;