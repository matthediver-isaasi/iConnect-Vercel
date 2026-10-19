-- Read-only accounting observation on archival metadata. Never an operational payment.
ALTER TABLE public.historical_member_invoice
  ADD COLUMN IF NOT EXISTS accounting_status text,
  ADD COLUMN IF NOT EXISTS accounting_payment_status text
    CHECK (accounting_payment_status IN ('unpaid', 'partial', 'paid', 'voided')),
  ADD COLUMN IF NOT EXISTS accounting_status_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS accounting_status_next_check_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS accounting_status_error text,
  ADD COLUMN IF NOT EXISTS accounting_status_failures integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS historical_invoice_status_due
  ON public.historical_member_invoice (accounting_status_next_check_at, tenant_id, id)
  WHERE record_kind = 'invoice';

GRANT UPDATE (accounting_status, accounting_payment_status, accounting_status_checked_at,
  accounting_status_next_check_at, accounting_status_error, accounting_status_failures)
  ON public.historical_member_invoice TO service_role;

-- Durable queue cursor: advance BEFORE network work, including crashes/time-budget exits.
-- Failed/unresolvable oldest rows cannot monopolise the next invocation. Lease expiry
-- retries abandoned work. SKIP LOCKED keeps overlapping invocations disjoint.
CREATE OR REPLACE FUNCTION public.claim_historical_invoice_status_refresh(p_limit integer DEFAULT 1000)
RETURNS SETOF public.historical_member_invoice
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  WITH ranked AS MATERIALIZED (
    SELECT id, accounting_status_next_check_at, tenant_id,
      CASE WHEN accounting_status_checked_at IS NULL OR accounting_status_checked_at <= now() - interval '21 hours'
        THEN 0 ELSE 1 END AS priority,
      row_number() OVER (PARTITION BY tenant_id ORDER BY
        CASE WHEN accounting_status_checked_at IS NULL OR accounting_status_checked_at <= now() - interval '21 hours'
          THEN 0 ELSE 1 END,
        accounting_status_next_check_at, id) AS position
    FROM public.historical_member_invoice
    WHERE record_kind = 'invoice' AND accounting_status_next_check_at <= now()
  ), candidates AS MATERIALIZED (
    SELECT h.id FROM public.historical_member_invoice h
    JOIN ranked r ON r.id = h.id
    WHERE r.position <= 1000
    ORDER BY r.priority, r.position, r.accounting_status_next_check_at, r.tenant_id, r.id
    LIMIT greatest(0, least(coalesce(p_limit, 1000), 1000))
    FOR UPDATE OF h SKIP LOCKED
  )
  UPDATE public.historical_member_invoice h
  SET accounting_status_next_check_at = now() + interval '15 minutes'
  FROM candidates c WHERE h.id = c.id
  RETURNING h.*;
$$;
REVOKE ALL ON FUNCTION public.claim_historical_invoice_status_refresh(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_historical_invoice_status_refresh(integer) TO service_role;

-- One bounded metadata write per provider batch, rather than 100 network DB writes.
-- Expected immutable identity + lease is a compare-and-swap against PDF binding,
-- concurrent import/repair and another worker; conflicts are never overwritten.
CREATE OR REPLACE FUNCTION public.apply_historical_invoice_status_batch(p_updates jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE affected integer;
BEGIN
  IF jsonb_typeof(p_updates) IS DISTINCT FROM 'array' OR jsonb_array_length(p_updates) > 100 THEN
    RAISE EXCEPTION 'Historical status update batch must contain at most 100 rows';
  END IF;
  IF (SELECT count(*) <> count(DISTINCT value->'expected'->>'id') FROM jsonb_array_elements(p_updates)) THEN
    RAISE EXCEPTION 'Duplicate historical status update identity';
  END IF;
  WITH updates AS (
    SELECT value->'expected' AS expected, value->'patch' AS patch FROM jsonb_array_elements(p_updates)
  )
  UPDATE public.historical_member_invoice h SET
    xero_document_id = CASE WHEN u.patch ? 'xero_document_id' THEN (u.patch->>'xero_document_id')::uuid ELSE h.xero_document_id END,
    xero_document_type = CASE WHEN u.patch ? 'xero_document_type' THEN u.patch->>'xero_document_type' ELSE h.xero_document_type END,
    accounting_status = CASE WHEN u.patch ? 'accounting_status' THEN u.patch->>'accounting_status' ELSE h.accounting_status END,
    accounting_payment_status = CASE WHEN u.patch ? 'accounting_payment_status' THEN u.patch->>'accounting_payment_status' ELSE h.accounting_payment_status END,
    accounting_status_checked_at = CASE WHEN u.patch ? 'accounting_status_checked_at' THEN (u.patch->>'accounting_status_checked_at')::timestamptz ELSE h.accounting_status_checked_at END,
    accounting_status_next_check_at = (u.patch->>'accounting_status_next_check_at')::timestamptz,
    accounting_status_error = u.patch->>'accounting_status_error',
    accounting_status_failures = (u.patch->>'accounting_status_failures')::integer
  FROM updates u
  WHERE h.id = (u.expected->>'id')::uuid
    AND h.tenant_id = (u.expected->>'tenant_id')::uuid
    AND h.record_kind = 'invoice'
    AND h.xero_company_id = u.expected->>'xero_company_id'
    AND h.invoice_number = u.expected->>'invoice_number'
    AND h.invoice_date = (u.expected->>'invoice_date')::date
    AND h.amount_minor = (u.expected->>'amount_minor')::bigint
    AND h.currency IS NOT DISTINCT FROM u.expected->>'currency'
    AND h.xero_document_id IS NOT DISTINCT FROM (u.expected->>'xero_document_id')::uuid
    AND h.xero_document_type IS NOT DISTINCT FROM u.expected->>'xero_document_type'
    AND h.accounting_status_next_check_at = (u.expected->>'accounting_status_next_check_at')::timestamptz;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_historical_invoice_status_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_historical_invoice_status_batch(jsonb) TO service_role;
