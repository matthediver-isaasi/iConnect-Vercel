BEGIN;
ALTER TABLE public.event_funnel_invoice_work ADD COLUMN issued_evidence jsonb;
CREATE FUNCTION public.event_funnel_invoice_evidence(p_tenant uuid,p_order uuid,p_work uuid,p_token uuid,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE w public.event_funnel_invoice_work;
BEGIN
 SELECT * INTO w FROM public.event_funnel_invoice_work WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_work FOR UPDATE;
 IF NOT FOUND OR w.provider<>'xero' OR w.status<>'processing' OR w.lease_token IS DISTINCT FROM p_token
   OR w.lease_expires_at IS NULL OR w.lease_expires_at<=clock_timestamp() OR p_token IS NULL THEN RETURN false;END IF;
 IF w.issued_evidence IS NOT NULL THEN RETURN w.issued_evidence=p_evidence;END IF;
 IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' OR pg_column_size(p_evidence)>1000000
   OR coalesce(p_evidence->>'InvoiceID','')='' OR coalesce(p_evidence#>>'{Contact,ContactID}','')=''
   OR (w.invoice_id IS NOT NULL AND w.invoice_id<>p_evidence->>'InvoiceID')
   OR p_evidence->>'CurrencyCode' IS DISTINCT FROM w.snapshot->>'currency'
   OR p_evidence->>'LineAmountTypes' IS DISTINCT FROM 'Inclusive'
   OR jsonb_typeof(p_evidence->'LineItems') IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_evidence->'LineItems') IS DISTINCT FROM
     jsonb_array_length(w.snapshot#>'{eventFunnel,lineAllocations}')
   OR (p_evidence->>'Total')::numeric IS DISTINCT FROM (w.snapshot->>'amount')::numeric
   OR (SELECT sum((value->>'LineAmount')::numeric) FROM jsonb_array_elements(p_evidence->'LineItems'))
      IS DISTINCT FROM (p_evidence->>'Total')::numeric
   OR (SELECT sum((value->>'TaxAmount')::numeric) FROM jsonb_array_elements(p_evidence->'LineItems'))
      IS DISTINCT FROM (p_evidence->>'TotalTax')::numeric
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'LineItems') WHERE
     coalesce(value->>'LineItemID','')='' OR coalesce(value->>'AccountCode','')='' OR coalesce(value->>'TaxType','')='')
   OR (SELECT count(*)<>count(DISTINCT value->>'LineItemID') FROM jsonb_array_elements(p_evidence->'LineItems')) THEN
   RAISE EXCEPTION 'Issued invoice evidence mismatch' USING ERRCODE='PT409';
 END IF;
 UPDATE public.event_funnel_invoice_work SET issued_evidence=p_evidence WHERE id=p_work;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_invoice_evidence(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_invoice_evidence(uuid,uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
