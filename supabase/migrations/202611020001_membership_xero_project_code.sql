ALTER TABLE public.membership_tier_config
  ADD COLUMN IF NOT EXISTS xero_project_code text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.membership_tier_config'::regclass
      AND conname = 'membership_tier_project_code_trimmed') THEN
    ALTER TABLE public.membership_tier_config
      ADD CONSTRAINT membership_tier_project_code_trimmed
      CHECK (xero_project_code IS NULL OR
        (xero_project_code = btrim(xero_project_code) AND xero_project_code <> ''));
  END IF;
END $$;

-- Capture new obligations; do not backfill old invoices or commitments.
ALTER TABLE public.member_membership_history
  ADD COLUMN IF NOT EXISTS xero_project_code text;
ALTER TABLE public.organisation_membership_history
  ADD COLUMN IF NOT EXISTS xero_project_code text;

COMMENT ON COLUMN public.membership_tier_config.xero_project_code IS
  'Optional Xero Projects tracking option for the membership fee line only; not the invoice PO reference.';
