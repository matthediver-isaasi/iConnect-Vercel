-- DEST rollout prerequisite for organisation DD term renewal. No existing
-- agreement, price, mandate or renewal authority is changed by this migration.
BEGIN;
ALTER TABLE public.membership_dd_renewals
  ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.membership_dd_renewals ALTER COLUMN member_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.membership_dd_renewals'::regclass
      AND conname = 'membership_dd_renewals_one_owner'
  ) THEN
    ALTER TABLE public.membership_dd_renewals
      ADD CONSTRAINT membership_dd_renewals_one_owner
      CHECK ((member_id IS NOT NULL)::integer + (organization_id IS NOT NULL)::integer = 1);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_dd_renewals_organization
  ON public.membership_dd_renewals(tenant_id, organization_id, renewal_year)
  WHERE organization_id IS NOT NULL;
COMMIT;