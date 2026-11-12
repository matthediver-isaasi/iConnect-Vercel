-- Permit only the receipt-backed removal of the shopping reservation token
-- from the cart answer. All commercial terms and other answers remain frozen.
BEGIN;
DO $$
DECLARE definition text; old_guard text; new_guard text;
BEGIN
  definition := pg_get_functiondef('public.guard_form_invoice_order()'::regprocedure);
  old_guard := $s$(NEW.submission_data-'__cart_receipt') IS DISTINCT FROM (OLD.submission_data-'__cart_receipt')$s$;
  new_guard := $s$(
        (NEW.submission_data-'__cart_receipt') IS DISTINCT FROM (OLD.submission_data-'__cart_receipt')
        AND NOT EXISTS (
          SELECT 1 FROM public.form_cart_receipt r
          WHERE r.submission_id=OLD.id AND r.tenant_id=OLD.tenant_id
            AND NEW.submission_data->r.field_id = r.answer
            AND ((OLD.submission_data->r.field_id) - 'reservation_id') = r.answer
            AND (NEW.submission_data-ARRAY['__cart_receipt',r.field_id])
              IS NOT DISTINCT FROM (OLD.submission_data-ARRAY['__cart_receipt',r.field_id])
        )
      )$s$;
  IF strpos(definition, new_guard)>0 THEN RETURN; END IF;
  IF strpos(definition, old_guard)=0 THEN RAISE EXCEPTION 'Unknown invoice immutability guard'; END IF;
  EXECUTE replace(definition, old_guard, new_guard);
END;
$$;
COMMIT;
