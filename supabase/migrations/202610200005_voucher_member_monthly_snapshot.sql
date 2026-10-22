-- Task 5241: additive owner parity; existing closed organisation rows untouched.
BEGIN;
ALTER TABLE public.voucher_monthly_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voucher_monthly_snapshot FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.voucher_monthly_snapshot TO service_role;
CREATE POLICY voucher_snapshot_service_access ON public.voucher_monthly_snapshot
  TO service_role USING (true) WITH CHECK (true);
ALTER TABLE public.voucher_monthly_snapshot ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE public.voucher_monthly_snapshot ADD COLUMN IF NOT EXISTS owner_member_id uuid REFERENCES public.member(id);
ALTER TABLE public.voucher_monthly_snapshot ADD CONSTRAINT voucher_snapshot_exactly_one_owner
  CHECK (num_nonnulls(organization_id, owner_member_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS voucher_monthly_snapshot_member_unique
  ON public.voucher_monthly_snapshot(tenant_id, owner_member_id, month)
  WHERE owner_member_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.validate_voucher_snapshot_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.owner_member_id IS DISTINCT FROM OLD.owner_member_id) THEN
    RAISE EXCEPTION 'Snapshot owner and tenant are immutable';
  END IF;
  IF NEW.owner_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.member WHERE id=NEW.owner_member_id AND tenant_id=NEW.tenant_id
  ) THEN RAISE EXCEPTION 'Snapshot member must belong to tenant'; END IF;
  IF NEW.organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.organization WHERE id=NEW.organization_id AND tenant_id=NEW.tenant_id
  ) THEN RAISE EXCEPTION 'Snapshot organisation must belong to tenant'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voucher_snapshot_tenant_owner BEFORE INSERT OR UPDATE
  ON public.voucher_monthly_snapshot FOR EACH ROW EXECUTE FUNCTION public.validate_voucher_snapshot_owner();
REVOKE ALL ON FUNCTION public.validate_voucher_snapshot_owner() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_voucher_snapshot_owner() TO service_role;
COMMIT;
