BEGIN;
DO $patch$
DECLARE d text; old text; replacement text;
BEGIN
 d:=pg_get_functiondef('public.public_invoice_po_bill(uuid,text,text,uuid,text,jsonb,numeric,text,text,jsonb)'::regprocedure);
 old:=$old$payment_method=''invoice'',public_invoice_po_billing_id=$1,
   purchaser_context=jsonb_set(purchaser_context,''{invoice_approval_id}'',to_jsonb($1))$old$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Public PO approval contract changed'; END IF;
 EXECUTE replace(d,old,$new$payment_method=''invoice'',public_invoice_po_billing_id=$1$new$);

 d:=pg_get_functiondef('public.guard_public_invoice_po_booking()'::regprocedure);
 old:=$old$IF (OLD.payment_method = 'public_invoice_po' OR NEW.payment_method = 'public_invoice_po')
       AND OLD.payment_method IS DISTINCT FROM NEW.payment_method THEN
      RAISE EXCEPTION 'Public Invoice / PO payment method is immutable';
    END IF;$old$;
 replacement:=$new$IF ((OLD.payment_method = 'public_invoice_po' OR NEW.payment_method = 'public_invoice_po')
       AND OLD.payment_method IS DISTINCT FROM NEW.payment_method)
       OR OLD.public_invoice_po_billing_id IS DISTINCT FROM NEW.public_invoice_po_billing_id THEN
      -- Only the service-owned approval transaction may convert an intention.
      -- Identity remains immutable; the dedicated link carries authority.
      IF NOT (OLD.payment_method='public_invoice_po' AND NEW.payment_method='invoice'
        AND OLD.public_invoice_po_billing_id IS NULL AND NEW.public_invoice_po_billing_id IS NOT NULL
        AND (to_jsonb(NEW)-'payment_method'-'public_invoice_po_billing_id')
          IS NOT DISTINCT FROM (to_jsonb(OLD)-'payment_method'-'public_invoice_po_billing_id')
        AND EXISTS(SELECT 1 FROM public.public_invoice_po_billing a
          WHERE a.id=NEW.public_invoice_po_billing_id AND a.tenant_id=OLD.tenant_id
            AND a.source=TG_TABLE_NAME AND a.booking_group_reference=OLD.booking_group_reference
            AND a.event_id=OLD.event_id AND a.original_records @> jsonb_build_array(to_jsonb(OLD))))
      THEN RAISE EXCEPTION 'Public Invoice / PO requires matching invoice approval'; END IF;
    END IF;$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Public PO immutability contract changed'; END IF;
 d:=replace(d,old,replacement);
 old:=$old$ELSIF NEW.purchaser_context IS NOT NULL THEN$old$;
 replacement:=$new$ELSIF NEW.purchaser_context IS NOT NULL AND NOT (
    NEW.payment_method='invoice' AND NEW.public_invoice_po_billing_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.public_invoice_po_billing a
      WHERE a.id=NEW.public_invoice_po_billing_id AND a.tenant_id=NEW.tenant_id
        AND a.source=TG_TABLE_NAME AND a.booking_group_reference=NEW.booking_group_reference
        AND a.event_id=NEW.event_id
        AND a.original_records @> jsonb_build_array(jsonb_build_object(
          'id',NEW.id,'purchaser_context',NEW.purchaser_context))))
  THEN$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Public PO purchaser reservation contract changed'; END IF;
 EXECUTE replace(d,old,replacement);
END $patch$;
NOTIFY pgrst,'reload schema';
COMMIT;
