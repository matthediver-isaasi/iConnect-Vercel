-- Per-event "Members can register others" setting. Defaults to allowed so
-- existing events keep their current behaviour. When false, signed-in members
-- may only book their own place; non-members and admin booking tools are unaffected.
BEGIN;
ALTER TABLE public.event ADD COLUMN IF NOT EXISTS members_can_register_others boolean NOT NULL DEFAULT true;
ALTER TABLE public.complex_event ADD COLUMN IF NOT EXISTS members_can_register_others boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.event.members_can_register_others IS 'When false, member bookings may include only the booking member.';
COMMENT ON COLUMN public.complex_event.members_can_register_others IS 'When false, member bookings may include only the booking member.';
NOTIFY pgrst, 'reload schema';
COMMIT;
