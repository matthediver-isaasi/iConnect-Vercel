-- Explicit owner-approved repair only; no service-role authority to approve.
CREATE TABLE IF NOT EXISTS public.event_invoice_payment_link_repair_audit (
 operation_id uuid PRIMARY KEY REFERENCES public.event_invoice_recovery(id),
 original_record jsonb NOT NULL,
 corrected_record jsonb NOT NULL,
 authority text NOT NULL CHECK (length(trim(authority))>20),
 approved_at timestamptz NOT NULL DEFAULT now(),
 CHECK (original_record->>'settlement_payment_intent_id' IS NULL),
 CHECK (corrected_record->>'settlement_payment_intent_id'=original_record#>>'{snapshot,settlement,paymentIntentId}'),
 CHECK ((original_record-ARRAY['settlement_payment_intent_id','status','reason_code','next_attempt_at','updated_at'])
       =(corrected_record-ARRAY['settlement_payment_intent_id','status','reason_code','next_attempt_at','updated_at']))
);
ALTER TABLE public.event_invoice_payment_link_repair_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_invoice_payment_link_repair_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.event_invoice_payment_link_repair_audit TO service_role;
CREATE TRIGGER event_invoice_payment_link_repair_append_only
BEFORE UPDATE OR DELETE ON public.event_invoice_payment_link_repair_audit
FOR EACH ROW EXECUTE FUNCTION public.event_invoice_tax_correction_append_only();

DO $migration$
DECLARE original text; marker text := E'BEGIN\n'; addition text;
BEGIN
 SELECT pg_get_functiondef('public.event_invoice_recovery_immutable()'::regprocedure) INTO original;
 IF position('event_invoice_payment_link_repair_audit' IN original)>0 THEN
   RAISE EXCEPTION 'Payment-link repair exception already installed';
 END IF;
 IF (length(original)-length(replace(original,marker,'')))/length(marker)<>1 THEN
   RAISE EXCEPTION 'Unexpected immutable guard body';
 END IF;
 addition := $guard$
 -- A reviewed missing payment claim, never a new payment or financial rewrite.
 IF OLD.tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'::uuid
 AND OLD.source='booking' AND OLD.status='needs_review'
 AND OLD.reason_code='booking_or_lease_changed' AND OLD.attempts=1
 AND OLD.settlement_payment_intent_id IS NULL
 AND OLD.invoice_id IS NULL AND OLD.payment_id IS NULL
 AND OLD.invoice_write_started_at IS NULL AND OLD.payment_write_started_at IS NULL
 AND OLD.lease_token IS NULL AND OLD.lease_expires_at IS NULL
 AND OLD.snapshot->>'paymentMethod'='stripe'
 AND OLD.snapshot#>>'{settlement,livemode}'='true'
 AND NEW.settlement_payment_intent_id=OLD.snapshot#>>'{settlement,paymentIntentId}'
 AND NEW.status='pending' AND NEW.reason_code IS NULL
 AND (to_jsonb(NEW)-ARRAY['settlement_payment_intent_id','status','reason_code','next_attempt_at','updated_at'])
     =(to_jsonb(OLD)-ARRAY['settlement_payment_intent_id','status','reason_code','next_attempt_at','updated_at'])
 AND EXISTS(SELECT 1 FROM public.event_invoice_tax_correction_audit t
   WHERE t.operation_id=OLD.id AND t.corrected_snapshot=OLD.snapshot)
 AND EXISTS(SELECT 1 FROM public.event_invoice_payment_link_repair_audit a
   WHERE a.operation_id=OLD.id AND a.original_record=to_jsonb(OLD) AND a.corrected_record=to_jsonb(NEW))
 THEN RETURN NEW; END IF;
 $guard$;
 EXECUTE replace(original,marker,marker||addition);
END $migration$;
