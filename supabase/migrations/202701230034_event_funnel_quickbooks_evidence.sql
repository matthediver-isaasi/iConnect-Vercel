BEGIN;
DO $$
DECLARE definition text;
 anchor text:=$a$UPDATE public.event_funnel_invoice_work SET status='complete',invoice_id=q.invoice_result->>'id',$a$;
 capture text:=$b$
  IF q.resolved_snapshot#>'{invoice,envelope,expected,funnelTaxLines}' IS NOT NULL THEN
    IF jsonb_typeof(q.invoice_result->'issuedInvoice') IS DISTINCT FROM 'object'
      OR q.invoice_result#>>'{issuedInvoice,Id}' IS DISTINCT FROM q.invoice_result->>'id'
      OR q.invoice_result#>>'{issuedInvoice,CustomerRef,value}' IS DISTINCT FROM
        q.resolved_snapshot#>>'{invoice,envelope,expected,contactId}'
      OR q.invoice_result#>>'{issuedInvoice,CurrencyRef,value}' IS DISTINCT FROM w.snapshot#>>'{invoice,currency}'
      OR (q.invoice_result#>>'{issuedInvoice,TotalAmt}')::numeric IS DISTINCT FROM
        (w.snapshot#>>'{invoice,amount}')::numeric
      OR jsonb_typeof(q.invoice_result#>'{issuedInvoice,taxAllocations}') IS DISTINCT FROM 'array'
      OR jsonb_array_length(q.invoice_result#>'{issuedInvoice,taxAllocations}') IS DISTINCT FROM
        jsonb_array_length(w.snapshot#>'{linkage,lineAllocations}')
      OR (w.issued_evidence IS NOT NULL AND w.issued_evidence IS DISTINCT FROM q.invoice_result->'issuedInvoice') THEN
      RAISE EXCEPTION 'Original QuickBooks invoice evidence mismatch' USING ERRCODE='PT409';
    END IF;
    UPDATE public.event_funnel_invoice_work SET issued_evidence=q.invoice_result->'issuedInvoice' WHERE id=w.id;
  END IF;
  $b$;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_quickbooks_link(uuid,uuid)'::regprocedure) INTO definition;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'QuickBooks evidence capture boundary changed';
 END IF;
 EXECUTE replace(definition,anchor,capture||anchor);
END $$;
COMMIT;
