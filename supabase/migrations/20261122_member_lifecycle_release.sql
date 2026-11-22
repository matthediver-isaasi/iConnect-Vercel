-- Installing this contract does not approve a policy or enable a tenant.
BEGIN;
DO $$
BEGIN
  IF to_regprocedure('public.member_lifecycle_apply_impact(uuid,uuid,uuid,text,text,text,text)') IS NULL
    OR to_regprocedure('public.member_lifecycle_guarded_annual_expiry(uuid,uuid)') IS NULL
    OR to_regprocedure('public.member_lifecycle_operational_ready()') IS NULL
    OR to_regprocedure('public.member_lifecycle_claim_notice(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Lifecycle runtime prerequisites are incomplete';
  END IF;
END $$;
ALTER TABLE public.member_lifecycle_policy DROP CONSTRAINT IF EXISTS member_lifecycle_policy_enabled_check;
INSERT INTO public.member_lifecycle_installation(version) VALUES(2) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION public.member_lifecycle_runtime_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.member_lifecycle_installation WHERE version=2)
$$;
REVOKE ALL ON FUNCTION public.member_lifecycle_runtime_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_runtime_ready() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
