-- Isolated staging for tenant-admin discovery of mandates already present in
-- the tenant's own GoCardless account. These tables intentionally have no
-- foreign keys to live billing mirrors, agreements, plans, or membership history.

CREATE TABLE IF NOT EXISTS public.gocardless_mandate_discovery_batch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'complete', 'partial', 'failed')),
  total_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  ambiguous_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_by TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gocardless_mandate_discovery_batch_id_tenant_uniq
  ON public.gocardless_mandate_discovery_batch (id, tenant_id);

CREATE INDEX IF NOT EXISTS gocardless_mandate_discovery_batch_tenant_idx
  ON public.gocardless_mandate_discovery_batch (tenant_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS gocardless_mandate_discovery_one_running_idx
  ON public.gocardless_mandate_discovery_batch (tenant_id)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS public.gocardless_mandate_discovery_row (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  gocardless_mandate_id TEXT NOT NULL,
  mandate_status TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
  gocardless_customer_id TEXT,
  customer_email TEXT,
  normalized_email TEXT,
  matched_member_id UUID,
  match_outcome TEXT NOT NULL
    CHECK (match_outcome IN ('matched', 'unmatched', 'ambiguous', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, gocardless_mandate_id),
  FOREIGN KEY (batch_id, tenant_id)
    REFERENCES public.gocardless_mandate_discovery_batch(id, tenant_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS member_id_tenant_discovery_uniq
  ON public.member (id, tenant_id);

ALTER TABLE public.gocardless_mandate_discovery_row
  DROP CONSTRAINT IF EXISTS gocardless_mandate_discovery_row_matched_member_tenant_fkey;
ALTER TABLE public.gocardless_mandate_discovery_row
  ADD CONSTRAINT gocardless_mandate_discovery_row_matched_member_tenant_fkey
  FOREIGN KEY (matched_member_id, tenant_id)
  REFERENCES public.member(id, tenant_id);

CREATE INDEX IF NOT EXISTS gocardless_mandate_discovery_row_tenant_batch_idx
  ON public.gocardless_mandate_discovery_row (tenant_id, batch_id);
CREATE INDEX IF NOT EXISTS gocardless_mandate_discovery_row_match_idx
  ON public.gocardless_mandate_discovery_row (tenant_id, matched_member_id)
  WHERE matched_member_id IS NOT NULL;

ALTER TABLE public.gocardless_mandate_discovery_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gocardless_mandate_discovery_row ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gocardless_mandate_discovery_batch FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.gocardless_mandate_discovery_row FROM PUBLIC, anon, authenticated;