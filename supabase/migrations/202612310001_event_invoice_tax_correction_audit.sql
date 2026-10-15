BEGIN;
-- Owner-operated corrections only: retain both immutable financial snapshots.
CREATE TABLE IF NOT EXISTS public.event_invoice_tax_correction_audit (
  operation_id uuid PRIMARY KEY REFERENCES public.event_invoice_recovery(id),
  original_snapshot jsonb NOT NULL,
  corrected_snapshot jsonb NOT NULL,
  authority text NOT NULL CHECK (length(trim(authority)) > 20),
  approved_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.event_invoice_tax_correction_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_invoice_tax_correction_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.event_invoice_tax_correction_audit TO service_role;
CREATE OR REPLACE FUNCTION public.event_invoice_tax_correction_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'Tax correction evidence is append-only'; END $$;
DROP TRIGGER IF EXISTS event_invoice_tax_correction_append_only ON public.event_invoice_tax_correction_audit;
CREATE TRIGGER event_invoice_tax_correction_append_only
BEFORE UPDATE OR DELETE ON public.event_invoice_tax_correction_audit
FOR EACH ROW EXECUTE FUNCTION public.event_invoice_tax_correction_append_only();

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF ROW(NEW.tenant_id,NEW.source,NEW.booking_group_reference,NEW.snapshot,NEW.connection_id,NEW.xero_tenant_id,NEW.settlement_payment_intent_id)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.source,OLD.booking_group_reference,OLD.snapshot,OLD.connection_id,OLD.xero_tenant_id,OLD.settlement_payment_intent_id) THEN
   -- No ambiguous/provider-attempted operation can enter this exception.
   -- Only the database owner may insert its exact before/after approval.
   IF OLD.status='needs_review' AND OLD.attempts=0
   AND OLD.reason_code='snapshot_unavailable'
   AND OLD.invoice_write_started_at IS NULL AND OLD.payment_write_started_at IS NULL
   AND OLD.invoice_id IS NULL AND OLD.payment_id IS NULL
   AND OLD.lease_token IS NULL AND OLD.lease_expires_at IS NULL
   AND NEW.status='pending' AND NEW.reason_code IS NULL
   AND (to_jsonb(NEW)-ARRAY['snapshot','status','next_attempt_at','reason_code','updated_at'])
     =(to_jsonb(OLD)-ARRAY['snapshot','status','next_attempt_at','reason_code','updated_at'])
   AND OLD.snapshot->'reviewReasons'='["Historical invoice gross total does not match the checkout amount"]'::jsonb
   AND (NEW.snapshot-ARRAY['invoice','originalInvoice','reviewReasons','invoiceLineAmountPolicies'])
     =(OLD.snapshot-ARRAY['invoice','originalInvoice','reviewReasons','invoiceLineAmountPolicies'])
   AND EXISTS(SELECT 1 FROM public.event_invoice_tax_correction_audit a
     WHERE a.operation_id=OLD.id AND a.original_snapshot=OLD.snapshot AND a.corrected_snapshot=NEW.snapshot)
   THEN RETURN NEW; END IF;
   -- Retain the existing, separate historical-evidence hydration contract.
   IF OLD.snapshot IS NULL AND OLD.status='needs_review' AND OLD.reason_code='snapshot_unavailable'
   AND NEW.status='pending'
   AND (to_jsonb(NEW)-ARRAY['snapshot','connection_id','xero_tenant_id','settlement_payment_intent_id','status','next_attempt_at','reason_code','updated_at'])
     =(to_jsonb(OLD)-ARRAY['snapshot','connection_id','xero_tenant_id','settlement_payment_intent_id','status','next_attempt_at','reason_code','updated_at'])
   AND (OLD.connection_id IS NULL OR OLD.connection_id=NEW.connection_id)
   AND (OLD.xero_tenant_id IS NULL OR OLD.xero_tenant_id=NEW.xero_tenant_id)
   AND (OLD.settlement_payment_intent_id IS NULL OR OLD.settlement_payment_intent_id=NEW.settlement_payment_intent_id)
   AND EXISTS(SELECT 1 FROM public.event_invoice_recovery_historical_evidence h WHERE h.operation_id=OLD.id
     AND h.state='hydrating' AND h.snapshot=NEW.snapshot
     AND NEW.connection_id=h.snapshot#>>'{provider,connectionId}'
     AND NEW.xero_tenant_id=h.snapshot#>>'{provider,xeroTenantId}'
     AND NEW.settlement_payment_intent_id IS NOT DISTINCT FROM
       CASE WHEN h.snapshot->>'paymentMethod'='stripe' THEN h.snapshot#>>'{settlement,paymentIntentId}' END)
   THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'Recovery identity and snapshot are immutable';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.event_invoice_tax_correction_append_only() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
