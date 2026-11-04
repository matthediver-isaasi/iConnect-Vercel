-- Explicit operator approvals only. Do not relax queue immutability.
CREATE TABLE IF NOT EXISTS public.accounting_reconnect_approval (
  request_id uuid PRIMARY KEY REFERENCES public.accounting_request_queue(id),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider='xero'),
  company_id text NOT NULL,
  previous_connection_id text NOT NULL,
  new_connection_id text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK(length(trim(reason))>0),
  revoked_at timestamptz,
  CHECK(previous_connection_id<>new_connection_id)
);
ALTER TABLE public.accounting_reconnect_approval ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_reconnect_approval FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_reconnect_approval TO service_role;
