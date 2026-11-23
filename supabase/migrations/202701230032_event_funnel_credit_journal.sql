BEGIN;
-- No direct service-role insertion: the authoritative producer must supply
-- original invoice/selection evidence under the order lock before activation.
CREATE TABLE public.event_funnel_credit_work (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,order_id uuid NOT NULL,
 reversal_id uuid NOT NULL REFERENCES public.event_funnel_reversal(id),
 invoice_work_id uuid NOT NULL REFERENCES public.event_funnel_invoice_work(id),
 snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','writing','needs_review','complete')),
 plan jsonb,allocation_amount_minor bigint CHECK(allocation_amount_minor>0),
 receipt jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id),
 UNIQUE(reversal_id,invoice_work_id)
);
CREATE UNIQUE INDEX event_funnel_credit_receipt_unique
 ON public.event_funnel_credit_work((snapshot->>'company_id'),(receipt->>'creditNoteId')) WHERE receipt IS NOT NULL;
ALTER TABLE public.event_funnel_credit_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_credit_work FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.event_funnel_credit_operation(p_tenant uuid,p_order uuid,p_id uuid,p_action text,p_value jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.event_funnel_credit_work; amount bigint; requested bigint;
BEGIN
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO j FROM public.event_funnel_credit_work
   WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.event_funnel_reversal r
   WHERE r.id=j.reversal_id AND r.tenant_id=p_tenant AND r.order_id=p_order
     AND r.cancelled_at IS NOT NULL AND r.state<>'released') THEN RETURN false;END IF;
 SELECT sum((value->>'amountMinor')::bigint) INTO amount FROM jsonb_array_elements(j.snapshot->'selected');
 IF amount IS NULL OR amount<=0 THEN RAISE EXCEPTION 'Original credit selections missing' USING ERRCODE='PT409';END IF;
 IF p_action='prepare' THEN
   IF j.plan IS NOT NULL THEN RETURN j.plan=p_value;END IF;
   IF j.status<>'pending' OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR pg_column_size(p_value)>1000000 OR p_value->>'version' IS DISTINCT FROM '1'
     OR (p_value->>'amountMinor')::bigint IS DISTINCT FROM amount
     OR p_value->>'CurrencyCode' IS DISTINCT FROM j.snapshot#>>'{original_invoice,CurrencyCode}'
     OR p_value->>'LineAmountTypes' IS DISTINCT FROM 'Inclusive'
     OR jsonb_typeof(p_value->'LineItems') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_value->'LineItems')=0
     OR (SELECT sum(round((value->>'UnitAmount')::numeric*(value->>'Quantity')::numeric*100))
       FROM jsonb_array_elements(p_value->'LineItems')) IS DISTINCT FROM amount
     OR (SELECT sum(round((value->>'TaxAmount')::numeric*100)) FROM jsonb_array_elements(p_value->'LineItems'))
       IS DISTINCT FROM (p_value->>'taxMinor')::bigint THEN
     RAISE EXCEPTION 'Credit plan differs from original authority' USING ERRCODE='PT409';
   END IF;
   UPDATE public.event_funnel_credit_work SET plan=p_value WHERE id=p_id;RETURN true;
 ELSIF p_action='begin' THEN
   IF j.status<>'pending' OR j.plan IS NULL THEN RETURN false;END IF;
   UPDATE public.event_funnel_credit_work SET status='writing' WHERE id=p_id;RETURN true;
 ELSIF p_action='allocate' THEN
   IF j.status NOT IN ('writing','needs_review') OR j.plan IS NULL OR j.allocation_amount_minor IS NOT NULL
     OR coalesce(p_value->>'amountMinor','')!~'^[0-9]+$' THEN RETURN false;END IF;
   requested:=(p_value->>'amountMinor')::bigint;
   IF requested<=0 OR requested>amount THEN RETURN false;END IF;
   UPDATE public.event_funnel_credit_work SET allocation_amount_minor=requested WHERE id=p_id;RETURN true;
 ELSIF p_action='complete' THEN
   IF j.plan IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR pg_column_size(p_value)>65536
     OR p_value->>'provider' IS DISTINCT FROM 'xero' OR coalesce(p_value->>'creditNoteId','')=''
     OR p_value->>'invoiceId' IS DISTINCT FROM j.snapshot->>'invoice_id'
     OR p_value->>'currency' IS DISTINCT FROM j.snapshot#>>'{original_invoice,CurrencyCode}'
     OR (p_value->>'amountMinor')::bigint IS DISTINCT FROM amount
     OR (p_value->>'taxMinor')::bigint IS DISTINCT FROM (j.plan->>'taxMinor')::bigint
     OR jsonb_typeof(p_value->'allocated') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_value->'allocationRequired') IS DISTINCT FROM 'boolean' THEN
     RAISE EXCEPTION 'Credit receipt differs from frozen instructions' USING ERRCODE='PT409';
   END IF;
   IF j.receipt IS NOT NULL AND (j.receipt-'allocated') IS DISTINCT FROM (p_value-'allocated') THEN RETURN false;END IF;
   IF j.receipt->'allocated'='true'::jsonb AND p_value->'allocated'<>'true'::jsonb THEN RETURN false;END IF;
   UPDATE public.event_funnel_credit_work SET receipt=p_value,status=CASE
     WHEN p_value->'allocationRequired'='true'::jsonb AND p_value->'allocated'='false'::jsonb THEN 'needs_review' ELSE 'complete' END
     WHERE id=p_id;RETURN true;
 END IF;
 RAISE EXCEPTION 'Unknown credit operation' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_credit_operation(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_credit_operation(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMIT;
