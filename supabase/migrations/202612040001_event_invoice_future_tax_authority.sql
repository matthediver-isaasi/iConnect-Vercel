-- Future checkout intents only. No backfill, ticket edits, or historical retries.
BEGIN;
CREATE TABLE IF NOT EXISTS public.event_invoice_recovery_tax_authority (
  operation_id uuid PRIMARY KEY REFERENCES public.event_invoice_recovery(id),
  resolved_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.event_invoice_recovery_tax_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_invoice_recovery_tax_authority FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_tax_authority_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Resolved tax authority is immutable';
END $$;
DROP TRIGGER IF EXISTS event_invoice_recovery_tax_authority_immutable ON public.event_invoice_recovery_tax_authority;
CREATE TRIGGER event_invoice_recovery_tax_authority_immutable
BEFORE UPDATE OR DELETE ON public.event_invoice_recovery_tax_authority
FOR EACH ROW EXECUTE FUNCTION public.event_invoice_recovery_tax_authority_immutable();

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_tax_authority(
  p_id uuid, p_token uuid, p_resolved jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.event_invoice_recovery; prior jsonb; original_line jsonb; resolved_line jsonb; i integer;
BEGIN
  IF NOT public.event_invoice_recovery_guard(p_id,p_token) THEN
    RAISE EXCEPTION 'Recovery lease unavailable';
  END IF;
  SELECT * INTO r FROM public.event_invoice_recovery WHERE id=p_id FOR UPDATE;
  SELECT resolved_snapshot INTO prior FROM public.event_invoice_recovery_tax_authority WHERE operation_id=p_id;
  IF prior IS NOT NULL THEN
    IF p_resolved IS NOT NULL AND p_resolved IS DISTINCT FROM prior THEN RAISE EXCEPTION 'Tax authority already exists'; END IF;
    RETURN prior;
  END IF;
  IF p_resolved IS NULL THEN RETURN NULL; END IF;
  IF r.snapshot#>>'{taxResolution,kind}' IS DISTINCT FROM 'future_checkout_provider_tax'
    OR r.snapshot ? 'legacyDiscovery'
    OR r.invoice_write_started_at IS NOT NULL OR r.payment_write_started_at IS NOT NULL
    OR r.invoice_id IS NOT NULL OR r.payment_id IS NOT NULL
    OR octet_length(p_resolved::text)>262144
    OR (p_resolved-ARRAY['invoice','resolvedTaxEvidence']) IS DISTINCT FROM (r.snapshot-'invoice')
    OR ((p_resolved->'invoice')-'LineItems') IS DISTINCT FROM ((r.snapshot->'invoice')-'LineItems')
    OR p_resolved#>'{resolvedTaxEvidence,provider}' IS DISTINCT FROM r.snapshot->'provider'
    OR jsonb_array_length(p_resolved#>'{invoice,LineItems}') IS DISTINCT FROM jsonb_array_length(r.snapshot#>'{invoice,LineItems}')
  THEN RAISE EXCEPTION 'Invalid resolved financial authority'; END IF;
  FOR i IN 0..jsonb_array_length(r.snapshot#>'{invoice,LineItems}')-1 LOOP
    original_line:=(r.snapshot#>'{invoice,LineItems}')->i;
    resolved_line:=(p_resolved#>'{invoice,LineItems}')->i;
    IF (original_line-ARRAY['TaxType','TaxAmount']) IS DISTINCT FROM (resolved_line-ARRAY['TaxType','TaxAmount'])
      OR (original_line ? 'TaxType' AND original_line->'TaxType' IS DISTINCT FROM resolved_line->'TaxType')
      OR (original_line ? 'TaxAmount' AND original_line->'TaxAmount' IS DISTINCT FROM resolved_line->'TaxAmount')
      OR coalesce(resolved_line->>'TaxType','')=''
      OR jsonb_typeof(resolved_line->'TaxAmount') IS DISTINCT FROM 'number'
    THEN RAISE EXCEPTION 'Resolved line changes checkout intent'; END IF;
  END LOOP;
  INSERT INTO public.event_invoice_recovery_tax_authority(operation_id,resolved_snapshot) VALUES(p_id,p_resolved);
  RETURN p_resolved;
END $$;
REVOKE ALL ON FUNCTION public.event_invoice_recovery_tax_authority(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.event_invoice_recovery_tax_authority_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_invoice_recovery_tax_authority(uuid,uuid,jsonb) TO service_role;

-- Explicit, non-defaulted overload avoids ambiguous old SQL/PostgREST calls.
-- Both connection selection and row selection filter capability. The immutable
-- original marker remains authoritative even after tax resolution is saved.
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_claim(
 p_tenant_id uuid,p_source text,p_group text,p_tax_resolution boolean
) RETURNS public.event_invoice_recovery
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.event_invoice_recovery_connection; r public.event_invoice_recovery; token uuid;
BEGIN
 IF p_source IS NOT NULL AND p_source NOT IN ('booking','complex_event_booking') THEN RAISE EXCEPTION 'Invalid source'; END IF;
 IF p_group IS NOT NULL AND (p_tenant_id IS NULL OR p_source IS NULL OR length(p_group) NOT BETWEEN 1 AND 200)
 THEN RAISE EXCEPTION 'Invalid targeted recovery scope'; END IF;
 SELECT c0.* INTO c FROM public.event_invoice_recovery_connection c0
 WHERE (p_tenant_id IS NULL OR c0.tenant_id=p_tenant_id)
 AND coalesce(c0.cooldown_until,'-infinity') <= now()
 AND coalesce(c0.lease_expires_at,'-infinity') <= now()
 AND EXISTS(SELECT 1 FROM public.event_invoice_recovery q WHERE q.connection_id=c0.connection_id
   AND q.tenant_id=c0.tenant_id
   AND (p_tax_resolution IS TRUE OR q.snapshot#>>'{taxResolution,kind}' IS DISTINCT FROM 'future_checkout_provider_tax')
   AND (q.status IN ('pending','retry') AND q.next_attempt_at<=now()
        OR q.status='processing' AND q.lease_expires_at<=now())
   AND (p_source IS NULL OR q.source=p_source) AND (p_group IS NULL OR q.booking_group_reference=p_group))
 ORDER BY (SELECT max(tc.last_claimed_at) FROM public.event_invoice_recovery_connection tc
   WHERE tc.tenant_id=c0.tenant_id) NULLS FIRST,
   c0.last_claimed_at NULLS FIRST,c0.connection_id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.event_invoice_recovery q
 WHERE q.connection_id=c.connection_id AND q.tenant_id=c.tenant_id
 AND (p_tax_resolution IS TRUE OR q.snapshot#>>'{taxResolution,kind}' IS DISTINCT FROM 'future_checkout_provider_tax')
 AND (q.status IN ('pending','retry') AND q.next_attempt_at<=now()
      OR q.status='processing' AND q.lease_expires_at<=now())
 AND (p_source IS NULL OR q.source=p_source) AND (p_group IS NULL OR q.booking_group_reference=p_group)
 ORDER BY q.next_attempt_at NULLS FIRST,q.created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 token:=gen_random_uuid();
 UPDATE public.event_invoice_recovery_connection SET lease_token=token,lease_expires_at=now()+interval '120 seconds',
 last_claimed_at=now() WHERE connection_id=c.connection_id;
 UPDATE public.event_invoice_recovery SET status='processing',lease_token=token,
 lease_expires_at=now()+interval '120 seconds',attempts=attempts+1,updated_at=now()
 WHERE id=r.id RETURNING * INTO r;
 RETURN r;
END $$;

-- Preserve the original signature, defaults and result type for every old
-- caller. Old binaries never see a tax-intent operation, including retries.
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_claim(
 p_tenant_id uuid DEFAULT NULL,p_source text DEFAULT NULL,p_group text DEFAULT NULL
) RETURNS public.event_invoice_recovery
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
 SELECT public.event_invoice_recovery_claim(p_tenant_id,p_source,p_group,false);
$$;
REVOKE ALL ON FUNCTION public.event_invoice_recovery_claim(uuid,text,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.event_invoice_recovery_claim(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_invoice_recovery_claim(uuid,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.event_invoice_recovery_claim(uuid,text,text) TO service_role;
COMMIT;