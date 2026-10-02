-- ADDITIVE, UNAPPLIED. Requires 202612050001 (also unapplied at authoring).
-- No legacy event/form writer ownership changes are made by this migration.
ALTER TABLE public.accounting_request_queue DROP CONSTRAINT IF EXISTS accounting_request_queue_operation_check;
ALTER TABLE public.accounting_request_queue ADD CONSTRAINT accounting_request_queue_operation_check CHECK (operation IN ('invoice','payment'));
ALTER TABLE public.accounting_request_queue ADD COLUMN IF NOT EXISTS preparation_status text NOT NULL DEFAULT 'done'
  CHECK (preparation_status IN ('pending','done'));
ALTER TABLE public.accounting_request_queue ADD COLUMN IF NOT EXISTS resolved_snapshot jsonb
  CHECK (resolved_snapshot IS NULL OR (jsonb_typeof(resolved_snapshot)='object' AND octet_length(resolved_snapshot::text)<=262144));
CREATE UNIQUE INDEX IF NOT EXISTS accounting_request_gc_payment_authority
  ON public.accounting_request_queue(tenant_id,source_type,source_id) WHERE source_type='gocardless_payment';

CREATE OR REPLACE FUNCTION public.accounting_request_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Accounting request authority cannot be deleted'; END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.provider,NEW.connection_id,NEW.company_id,NEW.source_type,NEW.source_id,NEW.operation,NEW.snapshot)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.provider,OLD.connection_id,OLD.company_id,OLD.source_type,OLD.source_id,OLD.operation,OLD.snapshot)
    OR (OLD.resolved_snapshot IS NOT NULL AND NEW.resolved_snapshot IS DISTINCT FROM OLD.resolved_snapshot)
    OR (OLD.preparation_status='done' AND NEW.preparation_status<>'done')
  THEN RAISE EXCEPTION 'Accounting request authority is immutable'; END IF;
  IF NEW.preparation_status='pending' AND (
    NEW.invoice_status IS DISTINCT FROM OLD.invoice_status OR NEW.payment_status IS DISTINCT FROM OLD.payment_status
    OR NEW.link_status IS DISTINCT FROM OLD.link_status OR NEW.state='complete')
  THEN RAISE EXCEPTION 'Accounting preparation prerequisites missing'; END IF;
  IF OLD.invoice_status='done' AND NEW.invoice_result IS DISTINCT FROM OLD.invoice_result
    AND NOT (OLD.operation='payment' AND OLD.preparation_status='pending' AND NEW.preparation_status='done'
      AND NEW.invoice_result->>'id'=OLD.invoice_result->>'id')
  THEN RAISE EXCEPTION 'Accounting invoice evidence is immutable'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.accounting_request_enqueue(
  p_tenant_id uuid,p_provider text,p_connection_id text,p_company_id text,
  p_source_type text,p_source_id text,p_operation text,p_snapshot jsonb
) RETURNS public.accounting_request_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE q public.accounting_request_queue; stage text; envelope jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('xero','quickbooks')
    OR p_connection_id IS NULL OR length(trim(p_connection_id)) NOT BETWEEN 1 AND 200 OR p_connection_id='PENDING_SELECTION'
    OR p_company_id IS NULL OR length(trim(p_company_id)) NOT BETWEEN 1 AND 200 OR p_company_id='PENDING_SELECTION'
    OR p_source_type IS NULL OR length(trim(p_source_type)) NOT BETWEEN 1 AND 100
    OR p_source_id IS NULL OR length(trim(p_source_id)) NOT BETWEEN 1 AND 200
    OR p_operation IS NULL OR p_operation NOT IN ('invoice','payment')
    OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR p_snapshot->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(p_snapshot->'invoice') IS DISTINCT FROM 'object' OR p_snapshot->'invoice'='{}'::jsonb
    OR jsonb_typeof(p_snapshot->'linkage') IS DISTINCT FROM 'object' OR p_snapshot->'linkage'='{}'::jsonb
    OR NOT (p_snapshot ? 'payment')
    OR (p_snapshot->'payment'<>'null'::jsonb AND (jsonb_typeof(p_snapshot->'payment')<>'object' OR p_snapshot->'payment'='{}'::jsonb))
    OR octet_length(p_snapshot::text)>262144
    OR (p_snapshot ? 'preparation' AND p_snapshot->'preparation' NOT IN ('true'::jsonb,'false'::jsonb))
    OR (p_operation='payment' AND (p_source_type<>'gocardless_payment'
      OR p_snapshot->'payment'='null'::jsonb OR p_snapshot->'preparation' IS DISTINCT FROM 'true'::jsonb
      OR jsonb_typeof(p_snapshot->'existingInvoice'->'id') IS DISTINCT FROM 'string'
      OR coalesce(length(trim(p_snapshot->'existingInvoice'->>'id')),0) NOT BETWEEN 1 AND 500))
  THEN RAISE EXCEPTION 'Invalid accounting request authority'; END IF;
  FOREACH stage IN ARRAY ARRAY['invoice','payment'] LOOP
    envelope := p_snapshot->stage->'envelope';
    IF envelope IS NOT NULL AND (
      jsonb_typeof(envelope) IS DISTINCT FROM 'object' OR envelope->'version' IS DISTINCT FROM '1'::jsonb
      OR envelope->>'provider' IS DISTINCT FROM p_provider OR envelope->>'kind' IS DISTINCT FROM stage
      OR coalesce(length(trim(envelope->>'operationKey')),0) NOT BETWEEN 1 AND 500
      OR jsonb_typeof(envelope->'payload') IS DISTINCT FROM 'object'
      OR jsonb_typeof(envelope->'expected') IS DISTINCT FROM 'object')
    THEN RAISE EXCEPTION 'Invalid accounting provider envelope'; END IF;
  END LOOP;
  INSERT INTO accounting_request_binding(provider,company_id) VALUES(p_provider,p_company_id) ON CONFLICT DO NOTHING;
  INSERT INTO accounting_request_queue(tenant_id,provider,connection_id,company_id,source_type,source_id,operation,snapshot,
    payment_status,invoice_status,invoice_result,preparation_status)
    VALUES(p_tenant_id,p_provider,p_connection_id,p_company_id,p_source_type,p_source_id,p_operation,p_snapshot,
      CASE WHEN p_snapshot->'payment'='null'::jsonb THEN 'skipped' ELSE 'pending' END,
      CASE WHEN p_operation='payment' THEN 'done' ELSE 'pending' END,
      CASE WHEN p_operation='payment' THEN p_snapshot->'existingInvoice' ELSE NULL END,
      CASE WHEN p_snapshot->'preparation'='true'::jsonb THEN 'pending' ELSE 'done' END)
    ON CONFLICT DO NOTHING;
  SELECT * INTO q FROM accounting_request_queue WHERE tenant_id=p_tenant_id AND source_type=p_source_type AND source_id=p_source_id
    AND (operation=p_operation OR p_source_type='gocardless_payment');
  IF q.id IS NULL OR ROW(q.provider,q.connection_id,q.company_id,q.operation,q.snapshot)
    IS DISTINCT FROM ROW(p_provider,p_connection_id,p_company_id,p_operation,p_snapshot)
  THEN RAISE EXCEPTION 'Accounting request identity conflicts with saved authority'; END IF;
  RETURN q;
END $$;

CREATE OR REPLACE FUNCTION public.accounting_request_prepare(p_id uuid,p_lease_token uuid,p_snapshot jsonb)
RETURNS public.accounting_request_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE q public.accounting_request_queue; stage text; envelope jsonb;
BEGIN
  SELECT * INTO q FROM accounting_request_queue WHERE id=p_id FOR UPDATE;
  PERFORM accounting_request_guard(p_id,p_lease_token,NULL);
  IF q.preparation_status IS DISTINCT FROM 'pending' OR q.resolved_snapshot IS NOT NULL
    OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR octet_length(p_snapshot::text)>262144 OR p_snapshot->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(p_snapshot->'invoice') IS DISTINCT FROM 'object' OR p_snapshot->'invoice'='{}'::jsonb
    OR p_snapshot->'linkage' IS DISTINCT FROM q.snapshot->'linkage'
    OR NOT (p_snapshot ? 'payment')
    OR (p_snapshot->'payment'='null'::jsonb) IS DISTINCT FROM (q.snapshot->'payment'='null'::jsonb)
    OR (p_snapshot->'payment'<>'null'::jsonb AND (jsonb_typeof(p_snapshot->'payment')<>'object' OR p_snapshot->'payment'='{}'::jsonb))
    OR p_snapshot->'preparation'='true'::jsonb
    OR (q.operation='payment' AND (p_snapshot->'existingInvoice'->>'id' IS DISTINCT FROM q.snapshot->'existingInvoice'->>'id'
      OR jsonb_typeof(p_snapshot->'existingInvoice'->'id') IS DISTINCT FROM 'string'))
  THEN RAISE EXCEPTION 'Invalid accounting preparation authority'; END IF;
  FOREACH stage IN ARRAY ARRAY['invoice','payment'] LOOP
    IF (stage='invoice' AND q.operation='payment') OR p_snapshot->stage='null'::jsonb THEN CONTINUE; END IF;
    envelope := p_snapshot->stage->'envelope';
    IF envelope IS NULL OR jsonb_typeof(envelope) IS DISTINCT FROM 'object'
      OR envelope->'version' IS DISTINCT FROM '1'::jsonb OR envelope->>'provider' IS DISTINCT FROM q.provider
      OR envelope->>'kind' IS DISTINCT FROM stage
      OR coalesce(length(trim(envelope->>'operationKey')),0) NOT BETWEEN 1 AND 500
      OR jsonb_typeof(envelope->'payload') IS DISTINCT FROM 'object'
      OR jsonb_typeof(envelope->'expected') IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'Invalid accounting prepared provider envelope'; END IF;
  END LOOP;
  UPDATE accounting_request_queue SET resolved_snapshot=p_snapshot,preparation_status='done',
    invoice_result=CASE WHEN operation='payment' THEN p_snapshot->'existingInvoice' ELSE invoice_result END,
    updated_at=now() WHERE id=p_id RETURNING * INTO q;
  RETURN q;
END $$;
REVOKE ALL ON FUNCTION public.accounting_request_prepare(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_request_prepare(uuid,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.accounting_request_enqueue(uuid,text,text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_request_enqueue(uuid,text,text,text,text,text,text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.accounting_request_immutable() FROM PUBLIC,anon,authenticated;