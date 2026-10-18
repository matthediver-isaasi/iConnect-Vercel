-- Forward only. Does not enqueue, invoice, send, or opt in historical sales.
BEGIN;
ALTER TABLE public.sales_invoice_schedule ADD COLUMN IF NOT EXISTS customer_resolution jsonb;
ALTER TABLE public.sales_invoice_schedule ADD COLUMN IF NOT EXISTS dispatch_claim_token uuid;
ALTER TABLE public.sales_invoice_schedule ADD COLUMN IF NOT EXISTS dispatch_claimed_at timestamptz;
ALTER TABLE public.sales_accounting_invoice_link ADD COLUMN IF NOT EXISTS schedule_id uuid;
ALTER TABLE public.sales_accounting_invoice_link
  DROP CONSTRAINT IF EXISTS sales_accounting_invoice_link_tenant_id_sale_id_provider_key;
CREATE UNIQUE INDEX IF NOT EXISTS sales_invoice_legacy_identity
  ON public.sales_accounting_invoice_link(tenant_id,sale_id,provider) WHERE schedule_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sales_invoice_schedule_identity
  ON public.sales_accounting_invoice_link(tenant_id,schedule_id) WHERE schedule_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sales_schedule_tenant_identity ON public.sales_invoice_schedule(tenant_id,id);
ALTER TABLE public.sales_accounting_invoice_link DROP CONSTRAINT IF EXISTS sales_invoice_schedule_fk;
ALTER TABLE public.sales_accounting_invoice_link ADD CONSTRAINT sales_invoice_schedule_fk
  FOREIGN KEY(tenant_id,schedule_id) REFERENCES public.sales_invoice_schedule(tenant_id,id);
CREATE INDEX IF NOT EXISTS sales_schedule_due_dispatch ON public.sales_invoice_schedule(next_attempt_at,planned_issue_date,tenant_id,id)
  WHERE status IN ('pending','blocked');
CREATE INDEX IF NOT EXISTS sales_schedule_due_delivery ON public.sales_invoice_schedule(next_attempt_at,tenant_id,id)
  WHERE status='invoiced' AND delivery_status IN ('pending','rejected','sending');
CREATE INDEX IF NOT EXISTS sales_schedule_tenant_work ON public.sales_invoice_schedule(tenant_id,next_attempt_at,id)
  WHERE status IN ('pending','blocked') OR (status='invoiced' AND delivery_status IN ('pending','rejected'));
CREATE INDEX IF NOT EXISTS sales_schedule_stale_delivery ON public.sales_invoice_schedule(delivery_claimed_at,id)
  WHERE status='invoiced' AND delivery_status='sending';
CREATE TABLE IF NOT EXISTS public.sales_invoice_schedule_worker_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  last_tenant_id uuid,last_completed_at timestamptz,last_counts jsonb
);
ALTER TABLE public.sales_invoice_schedule_worker_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_invoice_schedule_worker_state FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.sales_invoice_schedule_worker_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_sales_schedule_accounting_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.accounting_request_id IS NOT NULL AND
    (NEW.accounting_request_id,NEW.provider,NEW.provider_company_id,NEW.issue_date,NEW.due_date)
      IS DISTINCT FROM (OLD.accounting_request_id,OLD.provider,OLD.provider_company_id,OLD.issue_date,OLD.due_date)
    THEN RAISE EXCEPTION 'Accepted accounting ownership is immutable'; END IF;
  IF OLD.delivery_status='sent' AND (NEW.delivery_status,NEW.delivery_message_id,NEW.delivered_at)
    IS DISTINCT FROM (OLD.delivery_status,OLD.delivery_message_id,OLD.delivered_at)
    THEN RAISE EXCEPTION 'Confirmed delivery evidence is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sales_schedule_accounting_owner ON public.sales_invoice_schedule;
CREATE TRIGGER sales_schedule_accounting_owner BEFORE UPDATE ON public.sales_invoice_schedule
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_schedule_accounting_owner();

CREATE OR REPLACE FUNCTION public.guard_sales_scheduled_whole_invoice()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF (TG_TABLE_NAME='sales_accounting_invoice_attempt' OR to_jsonb(NEW)->>'schedule_id' IS NULL) AND EXISTS(
    SELECT 1 FROM sales_commercial_sale s JOIN sales_quote_version v ON v.tenant_id=s.tenant_id AND v.id=s.quote_version_id
    WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.sale_id AND v.billing_schedule IS NOT NULL
  ) THEN RAISE EXCEPTION 'Scheduled sales cannot use the whole-sale invoice writer'; END IF;
  IF TG_TABLE_NAME='sales_accounting_invoice_link' AND to_jsonb(NEW)->>'schedule_id' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM sales_invoice_schedule s WHERE s.tenant_id=NEW.tenant_id AND s.id=(to_jsonb(NEW)->>'schedule_id')::uuid
      AND s.sale_id=NEW.sale_id AND s.quote_version_id=NEW.quote_version_id AND s.provider=NEW.provider
  ) THEN RAISE EXCEPTION 'Invoice schedule source mismatch'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sales_scheduled_whole_attempt ON public.sales_accounting_invoice_attempt;
CREATE TRIGGER sales_scheduled_whole_attempt BEFORE INSERT ON public.sales_accounting_invoice_attempt
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_scheduled_whole_invoice();
DROP TRIGGER IF EXISTS sales_scheduled_whole_link ON public.sales_accounting_invoice_link;
CREATE TRIGGER sales_scheduled_whole_link BEFORE INSERT ON public.sales_accounting_invoice_link
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_scheduled_whole_invoice();

-- Queue tables may be introduced by a later-dated migration. PL/pgSQL resolves
-- these runtime dependencies when invoked; automation requires the queue schema.
CREATE OR REPLACE FUNCTION public.enqueue_sales_invoice_schedule(
  p_tenant uuid,p_schedule uuid,p_provider text,p_connection text,p_company text,p_snapshot jsonb,p_claim uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s sales_invoice_schedule; q jsonb; issue date; due date;
BEGIN
  SELECT * INTO s FROM sales_invoice_schedule WHERE tenant_id=p_tenant AND id=p_schedule FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Schedule not found'; END IF;
  IF s.accounting_request_id IS NOT NULL OR s.status IN ('queued','invoiced','no_invoice_required','attention') THEN RETURN to_jsonb(s); END IF;
  IF p_claim IS NULL OR s.dispatch_claim_token IS DISTINCT FROM p_claim
    OR s.dispatch_claimed_at<now()-interval '5 minutes' THEN RAISE EXCEPTION 'Dispatch lease is not owned'; END IF;
  IF NOT EXISTS(SELECT 1 FROM sales_commercial_sale sale JOIN sales_quote_version v
      ON v.tenant_id=sale.tenant_id AND v.id=sale.quote_version_id
      WHERE sale.tenant_id=p_tenant AND sale.id=s.sale_id AND v.id=s.quote_version_id
        AND v.status IN ('accepted','converted') AND v.billing_schedule IS NOT NULL)
    THEN RAISE EXCEPTION 'Schedule is not accepted'; END IF;
  issue := (now() AT TIME ZONE s.timezone)::date;
  IF s.planned_issue_date>issue THEN RAISE EXCEPTION 'Schedule is not due'; END IF;
  IF (s.snapshot->>'grossMinor')::bigint=0 THEN
    UPDATE sales_invoice_schedule SET status='no_invoice_required',updated_at=now() WHERE id=s.id;
    RETURN jsonb_build_object('status','no_invoice_required');
  END IF;
  due := issue + (s.snapshot#>>'{paymentTerms,days}')::integer;
  IF p_snapshot#>>'{linkage,scheduleId}' IS DISTINCT FROM s.id::text OR p_snapshot#>>'{linkage,saleId}' IS DISTINCT FROM s.sale_id::text
    OR p_snapshot#>>'{linkage,quoteVersionId}' IS DISTINCT FROM s.quote_version_id::text
    OR (p_snapshot#>>'{invoice,payload,issueDate}')::date IS DISTINCT FROM issue
    OR (p_snapshot#>>'{invoice,payload,dueDate}')::date IS DISTINCT FROM due
    OR (p_snapshot#>>'{invoice,payload,netMinor}')::bigint IS DISTINCT FROM (s.snapshot->>'netMinor')::bigint
    OR (p_snapshot#>>'{invoice,payload,taxMinor}')::bigint IS DISTINCT FROM (s.snapshot->>'taxMinor')::bigint
    OR (p_snapshot#>>'{invoice,payload,grossMinor}')::bigint IS DISTINCT FROM (s.snapshot->>'grossMinor')::bigint
    OR p_snapshot#>>'{invoice,payload,currency}' IS DISTINCT FROM s.snapshot->>'currency'
    THEN RAISE EXCEPTION 'Schedule command does not match frozen economics or dates'; END IF;
  SELECT to_jsonb(r) INTO q FROM accounting_request_enqueue(p_tenant,p_provider,p_connection,p_company,
    'sales_invoice_schedule',s.id::text,'invoice',p_snapshot) r;
  UPDATE sales_invoice_schedule SET status='queued',accounting_request_id=(q->>'id')::uuid,
    dispatch_claim_token=NULL,dispatch_claimed_at=NULL,next_attempt_at=now(),
    provider=q->>'provider',provider_company_id=q->>'company_id',
    issue_date=(q#>>'{snapshot,invoice,payload,issueDate}')::date,
    due_date=(q#>>'{snapshot,invoice,payload,dueDate}')::date,last_error=NULL,updated_at=now()
    WHERE tenant_id=p_tenant AND id=s.id RETURNING * INTO s;
  INSERT INTO sales_audit_event(tenant_id,actor_id,actor_type,action,entity_type,entity_id,after_data)
    VALUES(p_tenant,p_snapshot#>>'{linkage,actorId}',p_snapshot#>>'{linkage,actorType}',
      'invoice_schedule.queued','sales_invoice_schedule',s.id::text,
      jsonb_build_object('requestId',s.accounting_request_id,'provider',s.provider,
        'companyId',s.provider_company_id,'issueDate',s.issue_date,'dueDate',s.due_date));
  RETURN to_jsonb(s);
END $$;

CREATE OR REPLACE FUNCTION public.claim_sales_schedule_dispatch(p_tenant uuid,p_schedule uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE sales_invoice_schedule SET dispatch_claim_token=p_token,dispatch_claimed_at=now(),
    next_attempt_at=now()+interval '5 minutes'
    WHERE tenant_id=p_tenant AND id=p_schedule AND status IN ('pending','blocked')
      AND accounting_request_id IS NULL AND planned_issue_date<=(now() AT TIME ZONE timezone)::date
      AND (dispatch_claim_token IS NULL OR dispatch_claimed_at<now()-interval '5 minutes');
  RETURN FOUND;
END $$;

-- Explicit review of customer ambiguity adds a separate audited resolution; it
-- never rewrites the accepted economic command or permits an unknown invoice to
-- be retried as a new write.
CREATE OR REPLACE FUNCTION public.retry_sales_invoice_schedule_preparation(
  p_tenant uuid,p_schedule uuid,p_customer text,p_confirm boolean,p_actor text,p_actor_type text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s sales_invoice_schedule; q jsonb;
BEGIN
  SELECT * INTO s FROM sales_invoice_schedule WHERE tenant_id=p_tenant AND id=p_schedule FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Schedule not found'; END IF;
  SELECT to_jsonb(r) INTO q FROM accounting_request_queue r WHERE id=s.accounting_request_id AND tenant_id=p_tenant FOR UPDATE;
  IF q IS NULL OR q->>'source_type'<>'sales_invoice_schedule' OR q->>'source_id'<>s.id::text
    OR q->>'state'<>'review' OR q->>'preparation_status'<>'pending' OR q->>'invoice_status'<>'pending'
    OR q->'invoice_result' IS DISTINCT FROM 'null'::jsonb
    THEN RAISE EXCEPTION 'Only unwritten preparation reviews can be retried; unknown invoice outcomes require reconciliation'; END IF;
  IF s.last_error->>'code'='AMBIGUOUS_CUSTOMER_MATCH' THEN
    IF NOT coalesce(p_confirm,false) OR p_customer IS NULL OR NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(s.last_error#>'{details,candidates}') c WHERE c->>'id'=p_customer)
      THEN RAISE EXCEPTION 'Explicit selection from the provider customer candidates is required'; END IF;
    UPDATE sales_invoice_schedule SET customer_resolution=jsonb_build_object('providerCustomerId',p_customer,
      'confirmedBy',p_actor,'confirmedAt',now()),last_error=NULL WHERE tenant_id=p_tenant AND id=s.id;
  ELSIF p_customer IS NOT NULL THEN RAISE EXCEPTION 'Customer confirmation is not requested by this preparation';
  END IF;
  UPDATE accounting_request_queue SET state='retry',next_attempt_at=now(),last_error=NULL
    WHERE id=s.accounting_request_id AND tenant_id=p_tenant;
  INSERT INTO sales_audit_event(tenant_id,actor_id,actor_type,action,entity_type,entity_id,after_data)
    VALUES(p_tenant,p_actor,p_actor_type,'invoice_schedule.preparation_retry','sales_invoice_schedule',s.id::text,
      jsonb_build_object('requestId',s.accounting_request_id,'providerCustomerId',p_customer));
  SELECT * INTO s FROM sales_invoice_schedule WHERE tenant_id=p_tenant AND id=p_schedule;
  RETURN to_jsonb(s);
END $$;

CREATE OR REPLACE FUNCTION public.link_sales_invoice_schedule(p_tenant uuid,p_schedule uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s sales_invoice_schedule; q jsonb; l sales_accounting_invoice_link;
BEGIN
  SELECT * INTO s FROM sales_invoice_schedule WHERE tenant_id=p_tenant AND id=p_schedule FOR UPDATE;
  SELECT to_jsonb(r) INTO q FROM accounting_request_queue r WHERE tenant_id=p_tenant AND id=p_request
    AND source_type='sales_invoice_schedule' AND source_id=p_schedule::text;
  IF s.accounting_request_id IS DISTINCT FROM p_request OR q IS NULL OR q->>'invoice_status'<>'done'
    OR q#>>'{invoice_result,id}' IS NULL OR q->>'provider' IS DISTINCT FROM s.provider
    OR q->>'company_id' IS DISTINCT FROM s.provider_company_id
    THEN RAISE EXCEPTION 'Unverified schedule invoice authority'; END IF;
  INSERT INTO sales_accounting_invoice_link(tenant_id,sale_id,quote_version_id,schedule_id,provider,
    provider_invoice_id,provider_invoice_number,provider_invoice_url,provider_status,provider_status_raw,created_by)
    VALUES(p_tenant,s.sale_id,s.quote_version_id,s.id,s.provider,q#>>'{invoice_result,id}',
      coalesce(q#>>'{invoice_result,number}',q#>>'{invoice_result,invoiceNumber}'),q#>>'{invoice_result,url}',
      CASE lower(q#>>'{invoice_result,status}') WHEN 'paid' THEN 'paid' WHEN 'authorised' THEN 'authorised'
      WHEN 'open' THEN 'open' WHEN 'draft' THEN 'draft' ELSE 'unknown' END,
      q#>>'{invoice_result,status}',q#>>'{snapshot,linkage,actorId}')
    ON CONFLICT DO NOTHING;
  SELECT * INTO l FROM sales_accounting_invoice_link WHERE tenant_id=p_tenant AND schedule_id=s.id;
  IF l.provider_invoice_id IS DISTINCT FROM q#>>'{invoice_result,id}' THEN RAISE EXCEPTION 'Provider invoice is linked elsewhere'; END IF;
  UPDATE sales_invoice_schedule SET status='invoiced',last_error=NULL,next_attempt_at=now(),updated_at=now()
    WHERE tenant_id=p_tenant AND id=s.id;
  RETURN jsonb_build_object('linked',true,'linkId',l.id);
END $$;

CREATE OR REPLACE FUNCTION public.claim_sales_schedule_delivery(p_tenant uuid,p_schedule uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE sales_invoice_schedule SET delivery_status='sending',delivery_claim_token=p_token,
    delivery_claimed_at=now(),updated_at=now()
  WHERE tenant_id=p_tenant AND id=p_schedule AND status='invoiced' AND delivery_status IN ('pending','rejected')
    AND (next_attempt_at IS NULL OR next_attempt_at<=now());
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.finish_sales_schedule_delivery(
  p_tenant uuid,p_schedule uuid,p_token uuid,p_status text,p_message text,p_error jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_status NOT IN ('sent','rejected','attention') OR (p_status='sent' AND nullif(p_message,'') IS NULL)
    THEN RAISE EXCEPTION 'Invalid delivery evidence'; END IF;
  UPDATE sales_invoice_schedule SET delivery_status=p_status,delivery_message_id=p_message,
    delivered_at=CASE WHEN p_status='sent' THEN now() ELSE NULL END,last_error=p_error,
    next_attempt_at=now()+interval '15 minutes',updated_at=now()
    WHERE tenant_id=p_tenant AND id=p_schedule AND delivery_claim_token=p_token AND delivery_status='sending';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.due_sales_invoice_schedules(p_limit integer DEFAULT 40,p_dispatch boolean DEFAULT true)
RETURNS SETOF public.sales_invoice_schedule LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate sales_invoice_schedule; tenant_row record; cursor_id uuid; emitted integer:=0;
BEGIN
  SELECT last_tenant_id INTO cursor_id FROM sales_invoice_schedule_worker_state WHERE singleton FOR UPDATE;
  -- Unknown sends are held, never stolen by another worker.
  UPDATE sales_invoice_schedule SET delivery_status='attention',
    last_error=jsonb_build_object('code','SCHEDULE_SEND_UNKNOWN','message','Interrupted email send; reconcile provider evidence before resend'),
    updated_at=now() WHERE id IN (SELECT id FROM sales_invoice_schedule
      WHERE status='invoiced' AND delivery_status='sending' AND delivery_claimed_at<now()-interval '15 minutes'
      ORDER BY delivery_claimed_at LIMIT 100);
  -- Durable tenant cursor: at most 20 tenants and 100 indexed candidates each.
  -- Never sort/window the full global due population.
  FOR tenant_row IN
    SELECT id FROM (
      (SELECT id,0 AS section FROM tenant WHERE id>coalesce(cursor_id,'00000000-0000-0000-0000-000000000000'::uuid) ORDER BY id LIMIT 20)
      UNION ALL
      (SELECT id,1 AS section FROM tenant WHERE id<=coalesce(cursor_id,'00000000-0000-0000-0000-000000000000'::uuid) ORDER BY id LIMIT 20)
    ) tenants ORDER BY section,id LIMIT 20
  LOOP
    UPDATE sales_invoice_schedule_worker_state SET last_tenant_id=tenant_row.id WHERE singleton;
    FOR candidate IN SELECT s.* FROM sales_invoice_schedule s
      WHERE s.tenant_id=tenant_row.id AND s.next_attempt_at<=now()
        AND ((p_dispatch AND s.status IN ('pending','blocked'))
          OR (s.status='invoiced' AND s.accounting_request_id IS NOT NULL AND s.delivery_status IN ('pending','rejected')))
      ORDER BY s.next_attempt_at,s.id LIMIT 100
    LOOP
      IF candidate.status IN ('pending','blocked') THEN
        IF candidate.planned_issue_date>(now() AT TIME ZONE candidate.timezone)::date THEN
          UPDATE sales_invoice_schedule SET next_attempt_at=(planned_issue_date::timestamp AT TIME ZONE timezone)
            WHERE id=candidate.id AND tenant_id=candidate.tenant_id AND accounting_request_id IS NULL;
          CONTINUE;
        END IF;
        UPDATE sales_invoice_schedule SET dispatch_claim_token=gen_random_uuid(),dispatch_claimed_at=now(),
          next_attempt_at=now()+interval '5 minutes'
          WHERE id=candidate.id AND tenant_id=candidate.tenant_id AND status IN ('pending','blocked')
            AND accounting_request_id IS NULL
            AND (dispatch_claim_token IS NULL OR dispatch_claimed_at<now()-interval '5 minutes')
          RETURNING * INTO candidate;
        IF NOT FOUND THEN CONTINUE; END IF;
      END IF;
      RETURN NEXT candidate;
      emitted:=emitted+1;
      IF emitted>=least(100,greatest(1,p_limit)) THEN RETURN; END IF;
    END LOOP;
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.finish_sales_invoice_schedule_run(p_counts jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  UPDATE sales_invoice_schedule_worker_state SET last_completed_at=now(),last_counts=p_counts-'health' WHERE singleton
$$;
CREATE OR REPLACE FUNCTION public.sales_invoice_schedule_health()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object(
    'pending',count(*) FILTER (WHERE status='pending'),
    'blocked',count(*) FILTER (WHERE status='blocked'),
    'queued',count(*) FILTER (WHERE status='queued'),
    'invoiced',count(*) FILTER (WHERE status='invoiced'),
    'noInvoiceRequired',count(*) FILTER (WHERE status='no_invoice_required'),
    'deliveryPending',count(*) FILTER (WHERE status='invoiced' AND delivery_status IN ('pending','rejected')),
    'deliverySent',count(*) FILTER (WHERE delivery_status='sent'),
    'attention',count(*) FILTER (WHERE status='attention' OR delivery_status='attention'),
    'lastCompletedRun',(SELECT jsonb_build_object('at',last_completed_at,'counts',last_counts)
      FROM sales_invoice_schedule_worker_state WHERE singleton)
  ) FROM sales_invoice_schedule
$$;
REVOKE ALL ON FUNCTION public.enqueue_sales_invoice_schedule(uuid,uuid,text,text,text,jsonb,uuid),
  public.claim_sales_schedule_dispatch(uuid,uuid,uuid),
  public.retry_sales_invoice_schedule_preparation(uuid,uuid,text,boolean,text,text),
  public.link_sales_invoice_schedule(uuid,uuid,uuid),public.claim_sales_schedule_delivery(uuid,uuid,uuid),
  public.finish_sales_schedule_delivery(uuid,uuid,uuid,text,text,jsonb),public.due_sales_invoice_schedules(integer,boolean),
  public.finish_sales_invoice_schedule_run(jsonb),
  public.sales_invoice_schedule_health()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_sales_invoice_schedule(uuid,uuid,text,text,text,jsonb,uuid),
  public.claim_sales_schedule_dispatch(uuid,uuid,uuid),
  public.retry_sales_invoice_schedule_preparation(uuid,uuid,text,boolean,text,text),
  public.link_sales_invoice_schedule(uuid,uuid,uuid),public.claim_sales_schedule_delivery(uuid,uuid,uuid),
  public.finish_sales_schedule_delivery(uuid,uuid,uuid,text,text,jsonb),public.due_sales_invoice_schedules(integer,boolean),
  public.finish_sales_invoice_schedule_run(jsonb),
  public.sales_invoice_schedule_health()
  TO service_role;
COMMIT;
