-- Task 4786: reporting verification metadata only; no financial operations.
CREATE TABLE IF NOT EXISTS public.booking_credit_verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  booking_source text NOT NULL CHECK (booking_source IN ('booking', 'complex_event_booking')),
  booking_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN (
    'verified_empty', 'missing_reference', 'unsupported_route',
    'incomplete_coverage', 'lookup_failure', 'storage_failure'
  )),
  coverage jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  UNIQUE (tenant_id, booking_source, booking_id),
  CHECK (reason_code <> 'verified_empty' OR (
    verified_at IS NOT NULL
    AND coverage @> '{"allApplicableScopes":true,"paginationComplete":true}'::jsonb
  ))
);
ALTER TABLE public.booking_credit_verification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_credit_verification FROM anon, authenticated;
GRANT ALL ON public.booking_credit_verification TO service_role;