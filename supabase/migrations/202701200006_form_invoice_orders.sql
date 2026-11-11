-- Invoice orders are confirmed, unpaid submissions. Stock consumption and a
-- durable accounting request commit together; no simulated "paid" transition.
BEGIN;

DO $$
DECLARE definition text; old_guard text; new_guard text;
BEGIN
  definition := pg_get_functiondef('public.reserve_form_cart(uuid,uuid)'::regprocedure);
  old_guard := $s$submission.payment_provider NOT IN ('stripe','gocardless')$s$;
  IF strpos(definition, old_guard)=0 THEN RAISE EXCEPTION 'Unknown cart reservation provider guard'; END IF;
  definition := replace(definition, old_guard, $s$submission.payment_provider NOT IN ('stripe','gocardless','invoice')$s$);
  old_guard := $s$submission.payment_status IS DISTINCT FROM 'pending'$s$;
  IF strpos(definition, old_guard)=0 THEN RAISE EXCEPTION 'Unknown cart reservation payment guard'; END IF;
  definition := replace(definition, old_guard,
    $s$submission.payment_status IS DISTINCT FROM CASE WHEN submission.payment_provider='invoice' THEN 'unpaid' ELSE 'pending' END$s$);
  EXECUTE definition;

  definition := pg_get_functiondef('public.finalize_form_cart(uuid,uuid,text,jsonb)'::regprocedure);
  old_guard := $s$submission.payment_provider IS NOT NULL AND submission.payment_status IS DISTINCT FROM 'paid'$s$;
  IF strpos(definition, old_guard)=0 THEN RAISE EXCEPTION 'Unknown cart finalization payment guard'; END IF;
  definition := replace(definition, old_guard,
    $s$submission.payment_provider IS NOT NULL AND submission.payment_status IS DISTINCT FROM 'paid'
      AND NOT (submission.payment_provider='invoice' AND submission.payment_status='unpaid'
        AND submission.payment_meta->'invoice_order'->>'version'='1'
        AND EXISTS(SELECT 1 FROM public.accounting_request_queue q WHERE q.tenant_id=p_tenant_id
          AND q.source_type='form_invoice_order' AND q.source_id=p_submission_id::text))$s$);
  EXECUTE definition;
END;
$$;

CREATE FUNCTION public.guard_form_invoice_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE authority jsonb; fields jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.payment_provider='invoice' AND (
      NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.form_id IS DISTINCT FROM OLD.form_id
      OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
      OR NEW.payment_amount IS DISTINCT FROM OLD.payment_amount
      OR NEW.payment_currency IS DISTINCT FROM OLD.payment_currency
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.payment_meta->'invoice_order' IS DISTINCT FROM OLD.payment_meta->'invoice_order'
      OR (NEW.submission_data-'__cart_receipt') IS DISTINCT FROM (OLD.submission_data-'__cart_receipt')
    ) THEN RAISE EXCEPTION 'Accepted invoice order is immutable'; END IF;
    IF OLD.payment_provider IS DISTINCT FROM 'invoice' AND NEW.payment_provider='invoice' THEN
      RAISE EXCEPTION 'Existing checkouts cannot be converted to invoice orders';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.payment_provider IS DISTINCT FROM 'invoice' THEN RETURN NEW; END IF;
  IF current_setting('role',true) NOT IN ('service_role','none') THEN
    RAISE EXCEPTION 'Invoice checkout requires server authority' USING ERRCODE='42501';
  END IF;
  authority := NEW.payment_meta->'invoice_order';
  SELECT f.fields INTO fields FROM public.form f WHERE f.id=NEW.form_id AND f.tenant_id=NEW.tenant_id;
  IF authority IS NULL OR authority->>'version' IS DISTINCT FROM '1'
    OR authority->>'provider' IS DISTINCT FROM 'xero'
    OR authority->'snapshot'->>'preparation' IS DISTINCT FROM 'true'
    OR authority->'snapshot'->'payment' IS DISTINCT FROM 'null'::jsonb
    OR authority->'snapshot'->'linkage'->>'formId' IS DISTINCT FROM NEW.form_id::text
    OR (authority->>'amount')::numeric IS DISTINCT FROM NEW.payment_amount
    OR authority->>'currency' IS DISTINCT FROM NEW.payment_currency
    OR NEW.payment_amount<=0 OR NEW.payment_status IS DISTINCT FROM 'unpaid'
    OR NEW.idempotency_key IS NULL
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) f WHERE f->>'type'='payment'
      AND f->'payment_providers' ? 'invoice')
  THEN RAISE EXCEPTION 'Invalid invoice order authority'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER form_invoice_order_guard BEFORE INSERT OR UPDATE ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.guard_form_invoice_order();

CREATE FUNCTION public.enqueue_form_invoice_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE authority jsonb; receipt public.form_cart_receipt; snapshot jsonb;
BEGIN
  IF NEW.payment_provider IS DISTINCT FROM 'invoice' THEN RETURN NEW; END IF;
  authority:=NEW.payment_meta->'invoice_order';
  snapshot:=authority->'snapshot';
  SELECT * INTO receipt FROM public.form_cart_receipt WHERE tenant_id=NEW.tenant_id AND submission_id=NEW.id;
  IF FOUND AND (
    (receipt.terms->>'grossMinor')::numeric IS DISTINCT FROM NEW.payment_amount*100
    OR receipt.terms->>'currency' IS DISTINCT FROM NEW.payment_currency
    OR (SELECT jsonb_agg(jsonb_build_object('quantity',l->'quantity','netMinor',l->'netMinor',
      'taxMinor',l->'taxMinor','grossMinor',l->'grossMinor') ORDER BY ord)
      FROM jsonb_array_elements(receipt.terms->'lines') WITH ORDINALITY t(l,ord))
      IS DISTINCT FROM
      (SELECT jsonb_agg(jsonb_build_object('quantity',l->'quantity','netMinor',l->'netMinor',
      'taxMinor',l->'taxMinor','grossMinor',l->'grossMinor') ORDER BY ord)
      FROM jsonb_array_elements(snapshot->'lines') WITH ORDINALITY t(l,ord))
  ) THEN RAISE EXCEPTION 'Invoice and cart terms differ'; END IF;
  PERFORM public.accounting_request_enqueue(NEW.tenant_id,'xero',authority->>'connectionId',
    authority->>'companyId','form_invoice_order',NEW.id::text,'invoice',snapshot);
  IF receipt.id IS NOT NULL THEN
    PERFORM public.finalize_form_cart(NEW.tenant_id,NEW.id,'consumed');
  END IF;
  RETURN NEW;
END;
$$;
-- PostgreSQL orders same-event triggers by name: allocate_submission_cart
-- must have published the authoritative receipt before this trigger runs.
CREATE TRIGGER zz_enqueue_form_invoice_order AFTER INSERT ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_form_invoice_order();

CREATE FUNCTION public.form_invoice_order_version() RETURNS integer
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$ SELECT 1; $$;
REVOKE ALL ON FUNCTION public.guard_form_invoice_order(),public.enqueue_form_invoice_order(),
  public.form_invoice_order_version() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_invoice_order_version() TO service_role;
COMMIT;
