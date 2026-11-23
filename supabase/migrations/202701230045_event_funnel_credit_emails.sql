BEGIN;
CREATE TABLE public.event_funnel_credit_email(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,order_id uuid NOT NULL,
 reversal_id uuid NOT NULL REFERENCES public.event_funnel_reversal(id),
 credit_id uuid NOT NULL UNIQUE REFERENCES public.event_funnel_credit_work(id),
 recipient text NOT NULL,snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','writing','delivered','needs_review')),
 payload jsonb,attempt_token uuid,message_id text,
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
ALTER TABLE public.event_funnel_credit_email ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_credit_email FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.event_funnel_credit_email_ready(p_reversal uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.event_funnel_cancellation_cleanup c
   JOIN public.event_funnel_reversal r ON r.id=c.reversal_id WHERE c.reversal_id=p_reversal AND (
     nullif(c.snapshot->'authority'->>'creditNoteEmail','') IS NULL
     OR (SELECT sum((value->>'invoiceMinor')::bigint) FROM jsonb_array_elements(r.allocations))=0
     OR (EXISTS(SELECT 1 FROM public.event_funnel_credit_work WHERE reversal_id=p_reversal)
       AND NOT EXISTS(SELECT 1 FROM public.event_funnel_credit_work work LEFT JOIN public.event_funnel_credit_email email
         ON email.credit_id=work.id WHERE work.reversal_id=p_reversal
           AND (work.status<>'complete' OR email.state IS DISTINCT FROM 'delivered')))))
$$;
REVOKE ALL ON FUNCTION public.event_funnel_credit_email_ready(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.event_funnel_credit_email_operation(
 p_tenant uuid,p_order uuid,p_reversal uuid,p_lease uuid,p_action text,
 p_message uuid DEFAULT NULL,p_payload jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_reversal;c public.event_funnel_cancellation_cleanup;
 job public.event_funnel_credit_work;m public.event_funnel_credit_email;recipient text;rows jsonb;summary text;
 requested bigint;planned bigint;
BEGIN
 PERFORM 1 FROM public.event_funnel_order WHERE tenant_id=p_tenant AND id=p_order AND state='confirmed' FOR UPDATE;
 SELECT * INTO r FROM public.event_funnel_reversal WHERE tenant_id=p_tenant AND order_id=p_order AND id=p_reversal FOR UPDATE;
 IF NOT FOUND OR r.cancelled_at IS NULL OR NOT r.requires_cleanup OR r.state<>'processing'
   OR p_lease IS NULL OR r.lease_id IS DISTINCT FROM p_lease OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp()
   THEN RAISE EXCEPTION 'Credit email lease unavailable' USING ERRCODE='PT409';END IF;
 SELECT * INTO c FROM public.event_funnel_cancellation_cleanup WHERE tenant_id=p_tenant AND order_id=p_order AND reversal_id=p_reversal;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original credit email authority missing' USING ERRCODE='PT409';END IF;
 recipient:=nullif(trim(c.snapshot->'authority'->>'creditNoteEmail'),'');
 SELECT sum((value->>'invoiceMinor')::bigint) INTO requested FROM jsonb_array_elements(r.allocations);
 IF recipient IS NULL OR requested=0 THEN RETURN jsonb_build_object('status','complete','jobs','[]'::jsonb);END IF;
 IF p_action='read' THEN
   IF recipient!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(recipient)>320
     THEN RAISE EXCEPTION 'Invalid original credit email recipient';END IF;
   SELECT sum((selection->>'amountMinor')::bigint) INTO planned FROM public.event_funnel_credit_work w
     CROSS JOIN LATERAL jsonb_array_elements(w.snapshot->'selected') selection
     WHERE w.tenant_id=p_tenant AND w.order_id=p_order AND w.reversal_id=p_reversal;
   IF planned IS DISTINCT FROM requested OR EXISTS(SELECT 1 FROM public.event_funnel_credit_work
     WHERE tenant_id=p_tenant AND order_id=p_order AND reversal_id=p_reversal AND status<>'complete') THEN
     RETURN jsonb_build_object('status','retry','jobs','[]'::jsonb);
   END IF;
   FOR job IN SELECT * FROM public.event_funnel_credit_work WHERE tenant_id=p_tenant AND order_id=p_order
     AND reversal_id=p_reversal LOOP
     IF job.receipt->>'creditNoteId' IS NULL OR job.receipt->>'provider' IS DISTINCT FROM job.snapshot->>'provider'
       OR job.snapshot->>'company_id' IS NULL OR job.receipt->>'invoiceId' IS DISTINCT FROM job.snapshot->>'invoice_id'
       THEN RAISE EXCEPTION 'Original credit receipt unavailable' USING ERRCODE='PT409';END IF;
     INSERT INTO public.event_funnel_credit_email(tenant_id,order_id,reversal_id,credit_id,recipient,snapshot)
       VALUES(p_tenant,p_order,p_reversal,job.id,recipient,job.snapshot||jsonb_build_object('receipt',job.receipt))
       ON CONFLICT DO NOTHING;
   END LOOP;
 ELSE
   SELECT * INTO m FROM public.event_funnel_credit_email WHERE tenant_id=p_tenant AND order_id=p_order
     AND reversal_id=p_reversal AND id=p_message FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Credit email unavailable' USING ERRCODE='PT404';END IF;
   IF p_action='begin' THEN
     IF m.state='delivered' THEN RETURN jsonb_build_object('status','complete');END IF;
     IF m.state<>'pending' THEN RETURN jsonb_build_object('status','needs_review');END IF;
     IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text)>8000000
       OR p_payload->>'tenantId' IS DISTINCT FROM p_tenant::text OR p_payload->>'to' IS DISTINCT FROM m.recipient
       OR nullif(p_payload->>'subject','') IS NULL OR nullif(p_payload->>'html','') IS NULL
       OR jsonb_typeof(p_payload->'attachments') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'attachments')<>1
       OR p_payload->'attachments'->0->>'contentType' IS DISTINCT FROM 'application/pdf'
       OR nullif(p_payload->'attachments'->0->>'base64','') IS NULL
       OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('to','tenantId','subject','html','attachments'))
       THEN RAISE EXCEPTION 'Invalid credit email envelope';END IF;
     UPDATE public.event_funnel_credit_email SET payload=coalesce(payload,p_payload),state='writing',attempt_token=p_lease
       WHERE id=m.id RETURNING * INTO m;
     RETURN jsonb_build_object('status','send','payload',m.payload);
   ELSIF p_action='finish' THEN
     IF m.state='delivered' THEN RETURN jsonb_build_object('status','complete');END IF;
     IF m.state<>'writing' OR m.attempt_token IS DISTINCT FROM p_lease THEN
       RAISE EXCEPTION 'Credit email attempt changed' USING ERRCODE='PT409';END IF;
     IF p_payload->>'outcome' IS NULL OR p_payload->>'outcome' NOT IN ('accepted','not_submitted','unknown')
       THEN RAISE EXCEPTION 'Invalid credit email outcome';END IF;
     UPDATE public.event_funnel_credit_email SET state=CASE p_payload->>'outcome'
       WHEN 'accepted' THEN 'delivered' WHEN 'not_submitted' THEN 'pending' ELSE 'needs_review' END,
       message_id=left(p_payload->>'messageId',500) WHERE id=m.id;
   ELSE RAISE EXCEPTION 'Unknown credit email operation';END IF;
 END IF;
 SELECT CASE WHEN count(*) FILTER(WHERE state IN ('writing','needs_review'))>0 THEN 'needs_review'
   WHEN count(*) FILTER(WHERE state='pending')>0 THEN 'retry' ELSE 'complete' END INTO summary
   FROM public.event_funnel_credit_email WHERE reversal_id=p_reversal;
 SELECT coalesce(jsonb_agg(to_jsonb(j)),'[]') INTO rows FROM
   (SELECT * FROM public.event_funnel_credit_email WHERE reversal_id=p_reversal AND state='pending' ORDER BY id LIMIT 4) j;
 RETURN jsonb_build_object('status',summary,'jobs',rows);
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_credit_email_operation(uuid,uuid,uuid,uuid,text,uuid,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.event_funnel_credit_email_operation(uuid,uuid,uuid,uuid,text,uuid,jsonb) TO service_role;
DO $$
DECLARE def text;anchor text:='PERFORM public.event_funnel_suppress_cancelled_delivery(p_tenant,p_order);';
BEGIN
 SELECT pg_get_functiondef('public.event_funnel_cancellation_cleanup_quiet(uuid,uuid,uuid,uuid)'::regprocedure) INTO def;
 IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'Unexpected credit-email completion boundary';END IF;
 EXECUTE replace(def,anchor,$patch$
 IF NOT public.event_funnel_credit_email_ready(p_id) THEN
   reason:=coalesce(reason,'credit_email_receipts_required');
 END IF;
 $patch$||anchor);
END $$;
COMMIT;
