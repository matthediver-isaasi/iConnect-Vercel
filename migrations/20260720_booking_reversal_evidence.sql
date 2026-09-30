-- Reporting evidence only; no financial provider operations.
CREATE TABLE IF NOT EXISTS public.booking_reversal_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  booking_source text NOT NULL CHECK (booking_source IN ('booking', 'complex_event_booking')),
  evidence_key text NOT NULL,
  operation_key text NOT NULL,
  leg text NOT NULL CHECK (leg IN ('refund', 'credit_note')),
  provider text NOT NULL,
  provider_id text,
  amount_minor bigint CHECK (amount_minor >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('confirmed', 'pending', 'failed', 'unavailable')),
  booking_ids uuid[] NOT NULL,
  group_reference text,
  payment_reference text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, booking_source, evidence_key),
  CHECK (cardinality(booking_ids) > 0),
  CHECK (status <> 'confirmed' OR (amount_minor IS NOT NULL AND currency IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_reversal_provider_identity
  ON public.booking_reversal_evidence (tenant_id, provider, leg, provider_id)
  WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS booking_reversal_scope
  ON public.booking_reversal_evidence (tenant_id, booking_source);
CREATE INDEX IF NOT EXISTS booking_reversal_bookings
  ON public.booking_reversal_evidence USING gin (booking_ids);
ALTER TABLE public.booking_reversal_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_reversal_evidence FROM anon, authenticated;
GRANT ALL ON public.booking_reversal_evidence TO service_role;