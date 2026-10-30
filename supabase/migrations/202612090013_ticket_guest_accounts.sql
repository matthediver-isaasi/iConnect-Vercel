BEGIN;
-- Explicit opt-in: existing contact-only tickets and historical purchases retain
-- their original semantics. Simple-event tickets store this flag in pricing JSON.
ALTER TABLE public.complex_event_ticket_class
  ADD COLUMN IF NOT EXISTS auto_create_guest_accounts boolean NOT NULL DEFAULT false;

DO $patch$
DECLARE d text; old text; replacement text;
BEGIN
  d := pg_get_functiondef('public.provision_public_ticket_members(uuid)'::regprocedure);
  old := $old$purchase.snapshot->>'association_role_id' IS NOT NULL$old$;
  replacement := $new$(purchase.snapshot->>'association_role_id' IS NOT NULL OR coalesce(purchase.snapshot->>'guest_accounts'='true',false))$new$;
  IF position(old in d)=0 THEN RAISE EXCEPTION 'Provisioning unpaid evidence contract changed'; END IF;
  d := replace(d, old, replacement);
  old := $old$public.assert_registration_account_association(purchase.tenant_id,person->'association')$old$;
  replacement := $new$(public.assert_registration_account_association(purchase.tenant_id,person->'association')
    OR coalesce((purchase.snapshot->>'guest_accounts'='true' AND person->>'guest_account'='true'),false))$new$;
  IF position(old in d)=0 THEN RAISE EXCEPTION 'Provisioning account activation contract changed'; END IF;
  EXECUTE replace(d,old,replacement);

  d := pg_get_functiondef('public.insert_public_ticket_booking_batch(uuid,jsonb)'::regprocedure);
  old := $old$purchase.snapshot->>'association_role_id' IS NOT NULL$old$;
  replacement := $new$(purchase.snapshot->>'association_role_id' IS NOT NULL OR coalesce(purchase.snapshot->>'guest_accounts'='true',false))$new$;
  IF position(old in d)=0 THEN RAISE EXCEPTION 'Booking unpaid evidence contract changed'; END IF;
  EXECUTE replace(d,old,replacement);
END $patch$;
-- No new public entry points: existing service-only grants and immutable
-- purchase snapshots remain authoritative. No existing purchases are rewritten.
CREATE OR REPLACE FUNCTION public.ticket_guest_accounts_ready()
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp
AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.ticket_guest_accounts_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ticket_guest_accounts_ready() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
