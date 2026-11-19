-- Forward-only: invoice orders are accepted when the order/accounting request
-- commits, not when the invoice is paid. Never enqueue historical invoice rows.
BEGIN;
DO $$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.capture_form_submission_alerts()'::regprocedure);
  IF strpos(definition,'invoice_alert_insert_only') > 0 THEN RETURN; END IF;
  IF strpos(definition,'  row_data := to_jsonb(NEW);') = 0 OR
     strpos(definition,$s$  accepted := CASE WHEN row_data->>'payment_status' IS NOT NULL THEN$s$) = 0
  THEN RAISE EXCEPTION 'Unknown form alert capture contract'; END IF;
  definition := replace(definition,'  row_data := to_jsonb(NEW);',
    $s$  row_data := to_jsonb(NEW);
  -- invoice_alert_insert_only: no historical replay through ordinary edits.
  IF TG_OP='UPDATE' AND row_data->>'payment_provider'='invoice' THEN RETURN NEW; END IF;$s$);
  definition := replace(definition,
    $s$  accepted := CASE WHEN row_data->>'payment_status' IS NOT NULL THEN$s$,
    $s$  accepted := CASE WHEN row_data->>'payment_provider'='invoice' THEN
    row_data->>'payment_status'='unpaid'
      AND row_data#>>'{payment_meta,invoice_order,version}'='1'
      AND EXISTS(SELECT 1 FROM public.accounting_request_queue q
        WHERE q.tenant_id=NEW.tenant_id AND q.source_type='form_invoice_order'
          AND q.source_id=NEW.id::text AND q.operation='invoice')
    WHEN row_data->>'payment_status' IS NOT NULL THEN$s$);
  EXECUTE definition;
END $$;
-- Existing capture runs before zz_enqueue_form_invoice_order. This second
-- INSERT-only capture runs after durable accounting and stock finalization.
-- All effects share the submission transaction and roll back together.
DROP TRIGGER IF EXISTS zzz_capture_invoice_submission_alerts ON public.form_submission;
CREATE TRIGGER zzz_capture_invoice_submission_alerts AFTER INSERT ON public.form_submission
FOR EACH ROW WHEN (NEW.payment_provider='invoice' AND NEW.awards_amendment_application_id IS NULL)
EXECUTE FUNCTION public.capture_form_submission_alerts();
COMMIT;
