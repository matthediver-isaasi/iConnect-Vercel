BEGIN;
CREATE FUNCTION public.event_funnel_quickbooks_credit_authority(p_invoice jsonb,p_links jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE line jsonb; hint jsonb; link jsonb; i integer; items jsonb:='[]'; links jsonb:='[]';
 gross bigint:=0;tax bigint:=0;
BEGIN
 IF jsonb_typeof(p_invoice->'Line') IS DISTINCT FROM 'array'
   OR jsonb_typeof(p_invoice->'taxAllocations') IS DISTINCT FROM 'array'
   OR jsonb_typeof(p_links) IS DISTINCT FROM 'array'
   OR jsonb_typeof(p_invoice->'TotalAmt') IS DISTINCT FROM 'number'
   OR jsonb_typeof(p_invoice#>'{TxnTaxDetail,TotalTax}') IS DISTINCT FROM 'number'
   OR jsonb_array_length(p_invoice->'Line') NOT BETWEEN 1 AND 1000
   OR jsonb_array_length(p_invoice->'Line')<>jsonb_array_length(p_invoice->'taxAllocations')
   OR jsonb_array_length(p_invoice->'Line')<>jsonb_array_length(p_links)
   OR coalesce(p_invoice->>'Id','')='' OR coalesce(p_invoice#>>'{CustomerRef,value}','')=''
   OR coalesce(p_invoice->>'GlobalTaxCalculation','') NOT IN ('TaxInclusive','TaxExcluded') THEN
   RAISE EXCEPTION 'Original QuickBooks credit authority missing' USING ERRCODE='PT409';
 END IF;
 FOR line,i IN SELECT value,ordinality::integer-1 FROM jsonb_array_elements(p_invoice->'Line') WITH ORDINALITY LOOP
   hint:=p_invoice->'taxAllocations'->i;
   IF (hint->>'index')::integer IS DISTINCT FROM i OR coalesce(line->>'Id','')=''
     OR round((line->>'Amount')::numeric*100) IS DISTINCT FROM (hint->>'amountMinor')::bigint
     OR coalesce(line#>>'{SalesItemLineDetail,ItemRef,value}','')=''
     OR coalesce(line#>>'{SalesItemLineDetail,TaxCodeRef,value}','')='' THEN
     RAISE EXCEPTION 'Original QuickBooks line authority changed' USING ERRCODE='PT409';
   END IF;
   SELECT value INTO STRICT link FROM jsonb_array_elements(p_links) WHERE (value->>'index')::integer=i;
   gross:=gross+(hint->>'grossMinor')::bigint;tax:=tax+(hint->>'taxMinor')::bigint;
   links:=links||jsonb_build_array(jsonb_set(link,'{amountMinor}',hint->'grossMinor'));
   items:=items||jsonb_build_array(jsonb_build_object('LineItemID',line->>'Id','Description',line->>'Description',
     'Quantity',1,'UnitAmount',(hint->>'grossMinor')::numeric/100,'LineAmount',(hint->>'grossMinor')::numeric/100,
     'TaxAmount',(hint->>'taxMinor')::numeric/100,'TaxType',line#>>'{SalesItemLineDetail,TaxCodeRef,value}',
     'AccountCode',line#>>'{SalesItemLineDetail,ItemRef,value}'));
 END LOOP;
 IF gross IS DISTINCT FROM round((p_invoice->>'TotalAmt')::numeric*100)
   OR tax IS DISTINCT FROM round((p_invoice#>>'{TxnTaxDetail,TotalTax}')::numeric*100) THEN
   RAISE EXCEPTION 'Original QuickBooks totals changed' USING ERRCODE='PT409';
 END IF;
 RETURN jsonb_build_object('links',links,'invoice',jsonb_build_object('InvoiceID',p_invoice->>'Id',
   'Contact',jsonb_build_object('ContactID',p_invoice#>>'{CustomerRef,value}'),
   'CurrencyCode',p_invoice#>>'{CurrencyRef,value}','LineAmountTypes','Inclusive',
   'Total',p_invoice->'TotalAmt','TotalTax',p_invoice#>'{TxnTaxDetail,TotalTax}','LineItems',items));
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_quickbooks_credit_authority(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $$
DECLARE definition text; anchor text; replacement text;
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_credit_prepare(uuid,uuid,uuid)'::regprocedure) INTO definition;
 anchor:='payload jsonb;';
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Credit declaration boundary changed';END IF;
 definition:=replace(definition,anchor,'payload jsonb; native jsonb; normalized jsonb;');
 anchor:=$a$IF w.provider<>'xero' OR w.status<>'complete'$a$;
 replacement:=$b$native:=NULL;
   IF w.provider='quickbooks' THEN
     native:=w.issued_evidence;
     normalized:=public.event_funnel_quickbooks_credit_authority(native,w.snapshot#>'{linkage,lineAllocations}');
     w.issued_evidence:=normalized->'invoice';
     w.xero_tenant_id:=w.snapshot#>>'{approvalProvider,realmId}';
     w.snapshot:=jsonb_set(w.snapshot,'{eventFunnel}',jsonb_build_object('lineAllocations',normalized->'links'));
   END IF;
   IF w.provider NOT IN ('xero','quickbooks') OR w.status<>'complete'$b$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Credit provider boundary changed';END IF;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$'provider',w.provider,'invoice_id',w.invoice_id$a$;
 replacement:=$b$'provider',w.provider,'environment',w.snapshot->>'environment',
     'original_native_invoice',native,'credit_date',to_char(r.cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD'),
     'invoice_id',w.invoice_id$b$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Credit snapshot boundary changed';END IF;
 EXECUTE replace(definition,anchor,replacement);
 SELECT pg_get_functiondef('public.event_funnel_credit_operation(uuid,uuid,uuid,text,jsonb)'::regprocedure) INTO definition;
 anchor:=$a$p_value->>'provider' IS DISTINCT FROM 'xero'$a$;
 IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Credit receipt boundary changed';END IF;
 EXECUTE replace(definition,anchor,$b$p_value->>'provider' IS DISTINCT FROM coalesce(j.snapshot->>'provider','xero')$b$);
END $$;
DROP INDEX public.event_funnel_credit_receipt_unique;
CREATE UNIQUE INDEX event_funnel_credit_receipt_unique ON public.event_funnel_credit_work
 ((coalesce(snapshot->>'provider','xero')),(snapshot->>'company_id'),(receipt->>'creditNoteId')) WHERE receipt IS NOT NULL;
COMMIT;
