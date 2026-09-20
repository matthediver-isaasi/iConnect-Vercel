BEGIN;

ALTER TABLE public.event ADD COLUMN IF NOT EXISTS allow_public_invoice_po boolean NOT NULL DEFAULT false;
ALTER TABLE public.complex_event ADD COLUMN IF NOT EXISTS allow_public_invoice_po boolean NOT NULL DEFAULT false;
ALTER TABLE public.booking ADD COLUMN IF NOT EXISTS purchaser_context jsonb;
ALTER TABLE public.complex_event_booking ADD COLUMN IF NOT EXISTS purchaser_context jsonb;
ALTER TABLE public.booking ADD COLUMN IF NOT EXISTS purchase_order_number text;
ALTER TABLE public.complex_event_booking ADD COLUMN IF NOT EXISTS purchase_order_number text;

-- Payment methods in both existing tables are TEXT, not an enum. Do not alter
-- unrelated invoice/payment constraints or the capacity RPCs: the latter count
-- confirmed rows and do not perform inserts or copy a booking column whitelist.
CREATE OR REPLACE FUNCTION public.guard_public_invoice_po_booking()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  key text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.purchaser_context IS DISTINCT FROM NEW.purchaser_context THEN
      RAISE EXCEPTION 'Purchaser context is immutable';
    END IF;
    IF (OLD.payment_method = 'public_invoice_po' OR NEW.payment_method = 'public_invoice_po')
       AND OLD.payment_method IS DISTINCT FROM NEW.payment_method THEN
      RAISE EXCEPTION 'Public Invoice / PO payment method is immutable';
    END IF;
  END IF;
  IF NEW.payment_method = 'public_invoice_po' THEN
    IF NEW.purchaser_context IS NULL
       OR NEW.purchaser_context->>'classification' IS DISTINCT FROM 'public_non_member'
       OR NULLIF(NEW.purchaser_context->'details'->>'email', '') IS NULL THEN
      RAISE EXCEPTION 'Public Invoice / PO requires a public purchaser snapshot';
    END IF;
    -- member_id / organization_id may later link the attendee to an account.
    -- They are not purchaser classification; only the immutable snapshot is.
    FOREACH key IN ARRAY ARRAY['stripe_payment_intent_id', 'xero_invoice_id', 'xero_invoice_number',
      'accounting_invoice_id', 'accounting_invoice_number', 'accounting_provider', 'voucher_id'] LOOP
      IF NULLIF(row_data->>key, '') IS NOT NULL THEN
        RAISE EXCEPTION 'Public Invoice / PO cannot be linked to a payment or invoice';
      END IF;
    END LOOP;
    FOREACH key IN ARRAY ARRAY['voucher_amount', 'training_fund_amount', 'account_amount', 'account_balance_amount', 'total_paid'] LOOP
      IF COALESCE((row_data->>key)::numeric, 0) <> 0 THEN
        RAISE EXCEPTION 'Public Invoice / PO cannot collect or refund funds';
      END IF;
    END LOOP;
    IF COALESCE((row_data->>'po_to_follow')::boolean, false)
       OR (row_data ? 'payment_status' AND row_data->>'payment_status' IS DISTINCT FROM 'pending') THEN
      RAISE EXCEPTION 'Public Invoice / PO must remain unpaid and outside PO recovery';
    END IF;
  ELSIF NEW.purchaser_context IS NOT NULL THEN
    RAISE EXCEPTION 'Public purchaser context is reserved for Public Invoice / PO';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_public_invoice_po ON public.booking;
CREATE TRIGGER guard_public_invoice_po BEFORE INSERT OR UPDATE ON public.booking
FOR EACH ROW EXECUTE FUNCTION public.guard_public_invoice_po_booking();
DROP TRIGGER IF EXISTS guard_public_invoice_po ON public.complex_event_booking;
CREATE TRIGGER guard_public_invoice_po BEFORE INSERT OR UPDATE ON public.complex_event_booking
FOR EACH ROW EXECUTE FUNCTION public.guard_public_invoice_po_booking();

CREATE INDEX IF NOT EXISTS booking_public_invoice_po_tenant_event
  ON public.booking (tenant_id, event_id, created_at) WHERE payment_method = 'public_invoice_po';
CREATE INDEX IF NOT EXISTS complex_booking_public_invoice_po_tenant_event
  ON public.complex_event_booking (tenant_id, event_id, created_at) WHERE payment_method = 'public_invoice_po';
COMMIT;