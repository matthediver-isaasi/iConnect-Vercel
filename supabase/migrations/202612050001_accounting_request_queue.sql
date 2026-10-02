-- Durable shared invoice authority. Apply separately through the approved migration process.
CREATE TABLE IF NOT EXISTS public.accounting_request_binding (
  provider text NOT NULL CHECK (provider IN ('xero','quickbooks')),
  company_id text NOT NULL CHECK (length(trim(company_id)) BETWEEN 1 AND 200 AND company_id <> 'PENDING_SELECTION'),
  cooldown_until timestamptz NOT NULL DEFAULT '-infinity',
  lease_token uuid,
  lease_until timestamptz,
  PRIMARY KEY(provider,company_id)
);
CREATE TABLE IF NOT EXISTS public.accounting_request_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('xero','quickbooks')),
  connection_id text NOT NULL CHECK (length(trim(connection_id)) BETWEEN 1 AND 200),
  company_id text NOT NULL,
  source_type text NOT NULL CHECK (length(trim(source_type)) BETWEEN 1 AND 100),
  source_id text NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation = 'invoice'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 262144),
  invoice_status text NOT NULL DEFAULT 'pending' CHECK (invoice_status IN ('pending','writing','done','unknown')),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','writing','done','unknown','skipped')),
  link_status text NOT NULL DEFAULT 'pending' CHECK (link_status IN ('pending','writing','done')),
  invoice_result jsonb,
  payment_result jsonb,
  link_result jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','retry','running','unknown','complete','review')),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,source_type,source_id,operation),
  FOREIGN KEY(provider,company_id) REFERENCES public.accounting_request_binding(provider,company_id)
);
CREATE INDEX IF NOT EXISTS accounting_request_queue_due ON public.accounting_request_queue(next_attempt_at)
  WHERE state IN ('pending','retry','running','unknown');
ALTER TABLE public.accounting_request_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_request_binding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_request_queue,public.accounting_request_binding FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_request_queue,public.accounting_request_binding TO service_role;

CREATE OR REPLACE FUNCTION public.accounting_request_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Accounting request authority cannot be deleted'; END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.provider,NEW.connection_id,NEW.company_id,NEW.source_type,NEW.source_id,NEW.operation,NEW.snapshot)
     IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.provider,OLD.connection_id,OLD.company_id,OLD.source_type,OLD.source_id,OLD.operation,OLD.snapshot)
  THEN RAISE EXCEPTION 'Accounting request authority is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS accounting_request_immutable ON public.accounting_request_queue;
CREATE TRIGGER accounting_request_immutable BEFORE UPDATE OR DELETE ON public.accounting_request_queue
FOR EACH ROW EXECUTE FUNCTION public.accounting_request_immutable();

CREATE OR REPLACE FUNCTION public.accounting_request_enqueue(
  p_tenant_id uuid,p_provider text,p_connection_id text,p_company_id text,
  p_source_type text,p_source_id text,p_operation text,p_snapshot jsonb
) RETURNS public.accounting_request_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE q public.accounting_request_queue; stage text; envelope jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('xero','quickbooks')
    OR p_connection_id IS NULL OR length(trim(p_connection_id)) NOT BETWEEN 1 AND 200 OR p_connection_id='PENDING_SELECTION'
    OR p_company_id IS NULL OR length(trim(p_company_id)) NOT BETWEEN 1 AND 200 OR p_company_id = 'PENDING_SELECTION'
    OR p_source_type IS NULL OR length(trim(p_source_type)) NOT BETWEEN 1 AND 100
    OR p_source_id IS NULL OR length(trim(p_source_id)) NOT BETWEEN 1 AND 200
    OR p_operation IS DISTINCT FROM 'invoice'
    OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR p_snapshot->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(p_snapshot->'invoice') IS DISTINCT FROM 'object' OR p_snapshot->'invoice' = '{}'::jsonb
    OR jsonb_typeof(p_snapshot->'linkage') IS DISTINCT FROM 'object' OR p_snapshot->'linkage' = '{}'::jsonb
    OR NOT (p_snapshot ? 'payment')
    OR (p_snapshot->'payment' <> 'null'::jsonb AND (jsonb_typeof(p_snapshot->'payment') <> 'object' OR p_snapshot->'payment' = '{}'::jsonb))
    OR octet_length(p_snapshot::text) > 262144
  THEN RAISE EXCEPTION 'Invalid accounting request authority'; END IF;
  FOREACH stage IN ARRAY ARRAY['invoice','payment'] LOOP
    envelope := p_snapshot->stage->'envelope';
    IF envelope IS NOT NULL AND (
      jsonb_typeof(envelope) IS DISTINCT FROM 'object'
      OR envelope->'version' IS DISTINCT FROM '1'::jsonb
      OR envelope->>'provider' IS DISTINCT FROM p_provider
      OR envelope->>'kind' IS DISTINCT FROM stage
      OR coalesce(length(trim(envelope->>'operationKey')),0) NOT BETWEEN 1 AND 500
      OR jsonb_typeof(envelope->'payload') IS DISTINCT FROM 'object'
      OR jsonb_typeof(envelope->'expected') IS DISTINCT FROM 'object')
    THEN RAISE EXCEPTION 'Invalid accounting provider envelope'; END IF;
  END LOOP;
  INSERT INTO accounting_request_binding(provider,company_id) VALUES(p_provider,p_company_id) ON CONFLICT DO NOTHING;
  INSERT INTO accounting_request_queue(tenant_id,provider,connection_id,company_id,source_type,source_id,operation,snapshot,payment_status)
    VALUES(p_tenant_id,p_provider,p_connection_id,p_company_id,p_source_type,p_source_id,p_operation,p_snapshot,
      CASE WHEN p_snapshot->'payment' = 'null'::jsonb THEN 'skipped' ELSE 'pending' END)
    ON CONFLICT(tenant_id,source_type,source_id,operation) DO NOTHING;
  SELECT * INTO q FROM accounting_request_queue WHERE tenant_id=p_tenant_id AND source_type=p_source_type AND source_id=p_source_id AND operation=p_operation;
  IF ROW(q.provider,q.connection_id,q.company_id,q.snapshot) IS DISTINCT FROM ROW(p_provider,p_connection_id,p_company_id,p_snapshot)
  THEN RAISE EXCEPTION 'Accounting request identity conflicts with saved authority'; END IF;
  RETURN q;
END $$;

CREATE OR REPLACE FUNCTION public.accounting_request_claim(p_request_id uuid DEFAULT NULL)
RETURNS public.accounting_request_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE q public.accounting_request_queue; b public.accounting_request_binding; token uuid;
BEGIN
  FOR q IN SELECT r.* FROM accounting_request_queue r
    JOIN accounting_request_binding c ON c.provider=r.provider AND c.company_id=r.company_id
    WHERE (p_request_id IS NULL OR r.id=p_request_id)
      AND r.state IN ('pending','retry','running','unknown') AND r.next_attempt_at <= now()
      AND (r.lease_until IS NULL OR r.lease_until <= now())
      AND c.cooldown_until <= now() AND (c.lease_until IS NULL OR c.lease_until <= now())
    ORDER BY r.next_attempt_at,r.created_at LIMIT 50 FOR UPDATE OF r SKIP LOCKED
  LOOP
    SELECT * INTO b FROM accounting_request_binding
      WHERE provider=q.provider AND company_id=q.company_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND OR b.cooldown_until > now() OR b.lease_until > now() THEN CONTINUE; END IF;
    token := gen_random_uuid();
    UPDATE accounting_request_binding SET lease_token=token,lease_until=now()+interval '120 seconds'
      WHERE provider=q.provider AND company_id=q.company_id;
    UPDATE accounting_request_queue SET lease_token=token,lease_until=now()+interval '120 seconds',
      invoice_status=CASE WHEN invoice_status='writing' THEN 'unknown' ELSE invoice_status END,
      payment_status=CASE WHEN payment_status='writing' THEN 'unknown' ELSE payment_status END,
      link_status=CASE WHEN link_status='writing' THEN 'pending' ELSE link_status END,
      state='running',attempts=attempts+1,updated_at=now()
      WHERE id=q.id RETURNING * INTO q;
    RETURN q;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.accounting_request_checkpoint(
  p_id uuid,p_lease_token uuid,p_stage text,p_status text,p_result jsonb DEFAULT NULL
) RETURNS public.accounting_request_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE q public.accounting_request_queue; old_status text;
BEGIN
  SELECT * INTO q FROM accounting_request_queue WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR q.lease_token IS DISTINCT FROM p_lease_token OR q.lease_until <= now()
    OR NOT EXISTS(SELECT 1 FROM accounting_request_binding WHERE provider=q.provider AND company_id=q.company_id
      AND lease_token=p_lease_token AND lease_until>now() AND cooldown_until<=now())
  THEN RAISE EXCEPTION 'Accounting request lease lost'; END IF;
  IF p_stage IS NULL OR p_stage NOT IN ('invoice','payment','link') OR p_status IS NULL OR p_status NOT IN ('writing','done','unknown','pending')
  THEN RAISE EXCEPTION 'Invalid accounting checkpoint'; END IF;
  old_status := CASE p_stage WHEN 'invoice' THEN q.invoice_status WHEN 'payment' THEN q.payment_status ELSE q.link_status END;
  IF NOT ((old_status='pending' AND p_status='writing') OR (old_status='writing' AND p_status IN ('done','unknown','pending'))
    OR (old_status='unknown' AND p_status='done'))
  THEN RAISE EXCEPTION 'Invalid accounting stage transition'; END IF;
  IF (p_stage='payment' AND (q.invoice_status<>'done' OR q.snapshot->'payment'='null'::jsonb))
    OR (p_stage='link' AND (q.invoice_status<>'done' OR q.payment_status NOT IN ('done','skipped') OR p_status='unknown'))
  THEN RAISE EXCEPTION 'Accounting stage prerequisites missing'; END IF;
  IF p_status='done' AND (jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR octet_length(p_result::text)>262144
      OR (p_stage<>'link' AND (jsonb_typeof(p_result->'id') IS DISTINCT FROM 'string' OR length(trim(p_result->>'id'))=0))
      OR (p_stage='link' AND p_result->'linked' IS DISTINCT FROM 'true'::jsonb))
  THEN RAISE EXCEPTION 'Missing accounting result evidence'; END IF;
  UPDATE accounting_request_queue SET
    invoice_status=CASE WHEN p_stage='invoice' THEN p_status ELSE invoice_status END,
    payment_status=CASE WHEN p_stage='payment' THEN p_status ELSE payment_status END,
    link_status=CASE WHEN p_stage='link' THEN p_status ELSE link_status END,
    invoice_result=CASE WHEN p_stage='invoice' AND p_status='done' THEN p_result ELSE invoice_result END,
    payment_result=CASE WHEN p_stage='payment' AND p_status='done' THEN p_result ELSE payment_result END,
    link_result=CASE WHEN p_stage='link' AND p_status='done' THEN p_result ELSE link_result END,
    updated_at=now()
    WHERE id=p_id RETURNING * INTO q;
  RETURN q;
END $$;

CREATE OR REPLACE FUNCTION public.accounting_request_finish(
  p_id uuid,p_lease_token uuid,p_state text,p_error text DEFAULT NULL,
  p_retry_seconds integer DEFAULT 60,p_cooldown_seconds integer DEFAULT 0
) RETURNS public.accounting_request_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE q public.accounting_request_queue;
BEGIN
  SELECT * INTO q FROM accounting_request_queue WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR q.lease_token IS DISTINCT FROM p_lease_token OR q.lease_until<=now()
  THEN RAISE EXCEPTION 'Accounting request lease lost'; END IF;
  PERFORM 1 FROM accounting_request_binding WHERE provider=q.provider AND company_id=q.company_id
    AND lease_token=p_lease_token AND lease_until>now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Accounting binding lease lost'; END IF;
  IF p_state IS NULL OR p_state NOT IN ('retry','unknown','complete','review')
    OR p_retry_seconds IS NULL OR p_retry_seconds NOT BETWEEN 1 AND 604800
    OR p_cooldown_seconds IS NULL OR p_cooldown_seconds < -1
    OR (p_state='complete' AND (q.invoice_status<>'done' OR q.payment_status NOT IN ('done','skipped') OR q.link_status<>'done'))
    OR q.invoice_status='writing' OR q.payment_status='writing' OR q.link_status='writing'
    OR (p_state='retry' AND (q.invoice_status='unknown' OR q.payment_status='unknown'))
  THEN RAISE EXCEPTION 'Invalid accounting finish'; END IF;
  UPDATE accounting_request_binding SET cooldown_until=greatest(cooldown_until,
    CASE WHEN p_cooldown_seconds=-1 THEN 'infinity'::timestamptz ELSE now()+make_interval(secs=>p_cooldown_seconds) END),
    lease_token=NULL,lease_until=NULL WHERE provider=q.provider AND company_id=q.company_id;
  UPDATE accounting_request_queue SET state=CASE WHEN attempts>=30 AND p_state<>'complete' THEN 'review' ELSE p_state END,
    lease_token=NULL,lease_until=NULL,next_attempt_at=now()+make_interval(secs=>p_retry_seconds),
    last_error=left(p_error,200),updated_at=now() WHERE id=p_id RETURNING * INTO q;
  RETURN q;
END $$;

CREATE OR REPLACE FUNCTION public.accounting_request_guard(p_id uuid,p_lease_token uuid,p_stage text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE q public.accounting_request_queue;
BEGIN
  SELECT * INTO q FROM accounting_request_queue WHERE id=p_id;
  IF NOT FOUND OR p_lease_token IS NULL OR q.lease_token IS DISTINCT FROM p_lease_token
    OR q.lease_until <= now()+interval '35 seconds' OR q.state<>'running'
    OR NOT EXISTS(SELECT 1 FROM accounting_request_binding WHERE provider=q.provider AND company_id=q.company_id
      AND lease_token=p_lease_token AND lease_until>now()+interval '35 seconds' AND cooldown_until<=now())
  THEN RAISE EXCEPTION 'Accounting request lease or request budget lost'; END IF;
  IF p_stage IS NOT NULL AND (p_stage NOT IN ('invoice','payment')
    OR (p_stage='invoice' AND q.invoice_status<>'writing')
    OR (p_stage='payment' AND (q.payment_status<>'writing' OR q.invoice_status<>'done')))
  THEN RAISE EXCEPTION 'Accounting financial write not fenced'; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.accounting_request_guard(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_request_guard(uuid,uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.accounting_request_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public,pg_temp AS $$
  WITH counts AS (
    SELECT count(*) AS total,
      count(*) FILTER (WHERE q.state='pending') AS pending,
      count(*) FILTER (WHERE q.state='retry') AS retry,
      count(*) FILTER (WHERE q.state='running') AS running,
      count(*) FILTER (WHERE q.state='unknown') AS unknown,
      count(*) FILTER (WHERE q.state='review') AS review,
      count(*) FILTER (WHERE q.state='complete') AS complete,
      count(*) FILTER (WHERE q.state IN ('pending','retry','unknown')
        AND greatest(q.next_attempt_at,b.cooldown_until)<now()-interval '10 minutes') AS overdue,
      count(*) FILTER (WHERE q.state='running' AND q.lease_until<now()) AS expired_leases,
      count(*) FILTER (WHERE q.state IN ('pending','retry','unknown','running') AND b.cooldown_until>now()) AS waiting_provider
    FROM accounting_request_queue q
    JOIN accounting_request_binding b ON b.provider=q.provider AND b.company_id=q.company_id
  )
  SELECT to_jsonb(counts) || jsonb_build_object('status',
    CASE WHEN overdue+expired_leases+unknown+review>0 THEN 'attention'
      WHEN waiting_provider>0 THEN 'waiting_provider' ELSE 'healthy' END) FROM counts;
$$;
REVOKE ALL ON FUNCTION public.accounting_request_health() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_request_health() TO service_role;
REVOKE ALL ON FUNCTION public.accounting_request_immutable() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.accounting_request_enqueue(uuid,text,text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.accounting_request_claim(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.accounting_request_checkpoint(uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.accounting_request_finish(uuid,uuid,text,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_request_enqueue(uuid,text,text,text,text,text,text,jsonb),
  public.accounting_request_claim(uuid),public.accounting_request_checkpoint(uuid,uuid,text,text,jsonb),
  public.accounting_request_finish(uuid,uuid,text,text,integer,integer) TO service_role;