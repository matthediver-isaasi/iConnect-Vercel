-- Separate joining incentive evidence from complete rolling/DD commitments.
-- Additive only: no historical rewrite and no changes to commitment constraints.
ALTER TABLE public.member_membership_history
  ADD COLUMN IF NOT EXISTS incentive_snapshot jsonb;
ALTER TABLE public.organisation_membership_history
  ADD COLUMN IF NOT EXISTS incentive_snapshot jsonb;
COMMENT ON COLUMN public.member_membership_history.incentive_snapshot IS
  'Original Year 1 incentive configuration and annual net value; not dated commitment evidence.';
COMMENT ON COLUMN public.organisation_membership_history.incentive_snapshot IS
  'Original Year 1 incentive configuration and annual net value; not dated commitment evidence.';

-- Evidence is insert-only, including for legacy NULL rows. Payment, invoice and
-- status updates remain legal when they leave the snapshot unchanged.
CREATE OR REPLACE FUNCTION public.protect_membership_incentive_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.incentive_snapshot IS DISTINCT FROM OLD.incentive_snapshot THEN
    RAISE EXCEPTION 'Original membership incentive evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_membership_incentive_snapshot() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS protect_membership_incentive_snapshot ON public.member_membership_history;
CREATE TRIGGER protect_membership_incentive_snapshot
  BEFORE UPDATE ON public.member_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.protect_membership_incentive_snapshot();
DROP TRIGGER IF EXISTS protect_membership_incentive_snapshot ON public.organisation_membership_history;
CREATE TRIGGER protect_membership_incentive_snapshot
  BEFORE UPDATE ON public.organisation_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.protect_membership_incentive_snapshot();