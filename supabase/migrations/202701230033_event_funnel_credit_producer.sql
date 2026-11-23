BEGIN;
CREATE FUNCTION public.event_funnel_credit_prepare(p_tenant uuid,p_order uuid,p_reversal uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_reversal; w public.event_funnel_invoice_work; j public.event_funnel_credit_work;
 selected jsonb; priors jsonb; known jsonb; result jsonb:='[]'; payload jsonb;
BEGIN
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Credit order unavailable' USING ERRCODE='PT409';END IF;
 SELECT * INTO r FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_reversal;
 IF NOT FOUND OR r.cancelled_at IS NULL OR r.state='released' THEN
   RAISE EXCEPTION 'Accepted cancellation required' USING ERRCODE='PT409';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(r.allocations) a
   LEFT JOIN public.event_funnel_invoice_booking b ON b.tenant_id=p_tenant
     AND b.booking_source=a->>'source' AND b.booking_id=(a->>'id')::uuid
   WHERE (a->>'invoiceMinor')::bigint>0 AND b.invoice_work_id IS NULL) THEN
   RAISE EXCEPTION 'Original invoice delivery is not ready' USING ERRCODE='PT409';
 END IF;
 FOR w IN SELECT DISTINCT iw.* FROM public.event_funnel_invoice_work iw
   JOIN public.event_funnel_invoice_booking b ON b.invoice_work_id=iw.id AND b.tenant_id=p_tenant
   JOIN jsonb_array_elements(r.allocations) a ON b.booking_source=a->>'source' AND b.booking_id=(a->>'id')::uuid
   WHERE (a->>'invoiceMinor')::bigint>0 ORDER BY iw.id LOOP
   IF w.tenant_id<>p_tenant OR w.order_id<>p_order THEN RAISE EXCEPTION 'Invoice scope changed' USING ERRCODE='PT409';END IF;
   SELECT * INTO j FROM public.event_funnel_credit_work WHERE reversal_id=p_reversal AND invoice_work_id=w.id;
   IF FOUND THEN result:=result||jsonb_build_array(j.snapshot||to_jsonb(j));CONTINUE;END IF;
   IF w.provider<>'xero' OR w.status<>'complete' OR w.issued_evidence IS NULL
     OR w.issued_evidence->>'InvoiceID' IS DISTINCT FROM w.invoice_id
     OR coalesce(w.xero_tenant_id,'')='' OR coalesce(w.issued_evidence#>>'{Contact,ContactID}','')=''
     OR jsonb_typeof(w.snapshot#>'{eventFunnel,lineAllocations}') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'Original issued-invoice evidence unavailable' USING ERRCODE='PT409';END IF;
   IF EXISTS(SELECT 1 FROM public.event_funnel_credit_work c WHERE c.invoice_work_id=w.id AND
     (c.tenant_id<>p_tenant OR c.order_id<>p_order OR c.status<>'complete'
      OR c.receipt IS NULL OR c.receipt->>'invoiceId' IS DISTINCT FROM w.invoice_id
      OR c.receipt->>'currency' IS DISTINCT FROM w.issued_evidence->>'CurrencyCode'
      OR (c.receipt->>'amountMinor')::bigint IS DISTINCT FROM
        (SELECT sum((a->>'amountMinor')::bigint) FROM jsonb_array_elements(c.snapshot->'selected') a))) THEN
     RAISE EXCEPTION 'Earlier invoice credit requires reconciliation' USING ERRCODE='PT409';END IF;
   SELECT jsonb_agg(jsonb_build_object('source',a->>'source','id',a->>'id','amountMinor',(a->>'invoiceMinor')::bigint)
     ORDER BY a->>'source',a->>'id') INTO selected FROM jsonb_array_elements(r.allocations) a
     JOIN public.event_funnel_invoice_booking b ON b.tenant_id=p_tenant AND b.invoice_work_id=w.id
       AND b.booking_source=a->>'source' AND b.booking_id=(a->>'id')::uuid WHERE (a->>'invoiceMinor')::bigint>0;
   SELECT coalesce(jsonb_object_agg(k,total),'{}') INTO priors FROM(
     SELECT concat(a->>'source',':',a->>'id') k,sum((a->>'amountMinor')::bigint) total
     FROM public.event_funnel_credit_work c CROSS JOIN LATERAL jsonb_array_elements(c.snapshot->'selected') a
     WHERE c.invoice_work_id=w.id GROUP BY 1) totals;
   SELECT coalesce(jsonb_agg(c.receipt->>'creditNoteId' ORDER BY c.id),'[]') INTO known
     FROM public.event_funnel_credit_work c WHERE c.invoice_work_id=w.id;
   payload:=jsonb_build_object('provider',w.provider,'invoice_id',w.invoice_id,'company_id',w.xero_tenant_id,
     'original_invoice',w.issued_evidence,'line_allocations',w.snapshot#>'{eventFunnel,lineAllocations}',
     'prior_amounts',priors,'known_credit_ids',known,'selected',selected);
   INSERT INTO public.event_funnel_credit_work(tenant_id,order_id,reversal_id,invoice_work_id,snapshot)
     VALUES(p_tenant,p_order,p_reversal,w.id,payload) RETURNING * INTO j;
   result:=result||jsonb_build_array(j.snapshot||to_jsonb(j));
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_credit_prepare(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_credit_prepare(uuid,uuid,uuid) TO service_role;
COMMIT;
