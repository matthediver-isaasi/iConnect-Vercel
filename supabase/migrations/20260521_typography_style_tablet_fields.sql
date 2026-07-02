-- Task #974: Let typography styles control tablet sizing too.
--
-- Task #946 added `font_size_mobile`, and task #949 added the rest of the
-- mobile pair (`line_height_mobile`, `letter_spacing_mobile`,
-- `margin_bottom_mobile`). This migration completes the per-device set by
-- adding the matching tablet columns so the Canvas Text block, Hero
-- headline/sub-headline, and Card heading can render a distinct value at
-- the tablet breakpoint between desktop and mobile.
--
-- All four new columns are nullable. When NULL, the renderer cascades
-- mobile -> tablet -> desktop (matching task #970's per-device contract),
-- so existing rows with no tablet value behave exactly as they did
-- before this migration.

BEGIN;

ALTER TABLE public.typography_style
  ADD COLUMN IF NOT EXISTS font_size_tablet integer,
  ADD COLUMN IF NOT EXISTS line_height_tablet numeric,
  ADD COLUMN IF NOT EXISTS letter_spacing_tablet numeric,
  ADD COLUMN IF NOT EXISTS margin_bottom_tablet integer;

-- Ask PostgREST to reload its schema cache so the new columns are
-- immediately addressable through the REST API used by the admin editor
-- (`base44.entities.TypographyStyle`) and the public typography endpoint.
NOTIFY pgrst, 'reload schema';

COMMIT;
