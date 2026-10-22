-- Task 5241. Immutable token-bound previews; no voucher balance mutation.
-- Requires the existing membership_fee_token and member tables.
CREATE TABLE IF NOT EXISTS public.membership_voucher_quote (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  fee_token_id uuid NOT NULL REFERENCES public.membership_fee_token(id) ON DELETE CASCADE,
  member_id uuid REFERENCES public.member(id),
  organization_id uuid REFERENCES public.organization(id),
  authenticated_member_id uuid REFERENCES public.member(id),
  fingerprint text NOT NULL,
  quote jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_voucher_quote_owner CHECK (num_nonnulls(member_id,organization_id)=1),
  CONSTRAINT membership_voucher_quote_totals CHECK (
    (quote->>'grossMinor')::bigint >= 0
    AND (quote->>'creditMinor')::bigint >= 0
    AND (quote->>'cashMinor')::bigint >= 0
    AND (quote->>'grossMinor')::bigint =
      (quote->>'creditMinor')::bigint + (quote->>'cashMinor')::bigint
  )
);
CREATE INDEX IF NOT EXISTS membership_voucher_quote_token
  ON public.membership_voucher_quote (tenant_id, fee_token_id, created_at DESC);
ALTER TABLE public.membership_voucher_quote ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_voucher_quote FROM anon, authenticated;
GRANT SELECT, INSERT ON public.membership_voucher_quote TO service_role;
CREATE POLICY membership_voucher_quote_service ON public.membership_voucher_quote
  TO service_role USING (true) WITH CHECK (true);
