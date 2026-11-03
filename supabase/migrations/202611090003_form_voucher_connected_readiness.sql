BEGIN;
-- Older deployments must remain disabled: they do not preserve the owning
-- form's draft/receipt or finalize mixed-funded post-grace dates.
CREATE FUNCTION public.form_membership_voucher_checkout_ready_v2() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.form_membership_voucher_checkout_ready_v2() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_membership_voucher_checkout_ready_v2() TO service_role;
COMMIT;
