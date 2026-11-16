-- Service-only durable send claims. No lease expiry: an ambiguous mail-provider
-- result must never silently authorize another send for the same operation.
CREATE TABLE IF NOT EXISTS public.zoom_confirmation_delivery (
  tenant_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('event', 'session')),
  resource_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  target text NOT NULL,
  state text NOT NULL CHECK (state IN ('claimed', 'completed')),
  results jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, scope, resource_id, operation_id, booking_id),
  CHECK ((state = 'claimed' AND results IS NULL AND completed_at IS NULL)
    OR (state = 'completed' AND jsonb_typeof(results) = 'array' AND completed_at IS NOT NULL))
);
ALTER TABLE public.zoom_confirmation_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoom_confirmation_delivery FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.zoom_confirmation_delivery TO service_role;
GRANT UPDATE (state, results, completed_at) ON public.zoom_confirmation_delivery TO service_role;
