-- Private (unlisted) events: active and bookable by direct link, but left out
-- of the /Events calendar, group event lists, site search and the sitemap.
-- Canvas page event widgets still show them. Discovery only, never access control.
BEGIN;
ALTER TABLE public.event ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
ALTER TABLE public.complex_event ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.event.is_private IS 'Unlisted: hidden from Events calendar, group lists, search and sitemap; still shown in Canvas event widgets and by direct link.';
COMMENT ON COLUMN public.complex_event.is_private IS 'Unlisted: hidden from Events calendar, group lists, search and sitemap; still shown in Canvas event widgets and by direct link.';
NOTIFY pgrst, 'reload schema';
COMMIT;
