-- Financial intent, separate from cancellation approval and reporting evidence.
CREATE TABLE IF NOT EXISTS public.cancellation_credit_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  operation_key text NOT NULL,
  booking_source text NOT NULL CHECK (booking_source IN ('booking','complex_event_booking')),
  booking_ids uuid[] NOT NULL CHECK (cardinality(booking_ids)>0),
  invoice_id text NOT NULL,
  company_id text NOT NULL,
  amount numeric NOT NULL CHECK (amount>0),
  description text NOT NULL,
  reference text NOT NULL CHECK (length(reference)>0),
  email_requested text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','retry','review','complete')),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  result jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,operation_key),
  UNIQUE(tenant_id,invoice_id,reference)
);
CREATE INDEX IF NOT EXISTS cancellation_credit_operation_due
  ON public.cancellation_credit_operation(next_attempt_at) WHERE state IN ('pending','retry');
CREATE INDEX IF NOT EXISTS cancellation_credit_operation_bookings
  ON public.cancellation_credit_operation USING gin(booking_ids);
ALTER TABLE public.cancellation_credit_operation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cancellation_credit_operation FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.cancellation_credit_operation TO service_role;
