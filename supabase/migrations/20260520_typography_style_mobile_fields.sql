-- Task #949: Let typography styles control mobile line-height and spacing too.
--
-- Task #946 added `font_size_mobile` so the Canvas Text block can render a
-- distinct font size below the mobile breakpoint via a media-query rule.
-- This migration extends the same pattern to the other typography fields
-- that meaningfully differ between desktop and mobile: line-height,
-- letter-spacing, and margin-bottom. `text_transform` almost never needs a
-- mobile variant so it is intentionally left out.
--
-- All three new columns are nullable. When NULL, the renderer falls back
-- to the desktop value (no media-query override is emitted), matching the
-- existing `font_size_mobile` semantics.

BEGIN;

ALTER TABLE public.typography_style
  ADD COLUMN IF NOT EXISTS line_height_mobile numeric,
  ADD COLUMN IF NOT EXISTS letter_spacing_mobile numeric,
  ADD COLUMN IF NOT EXISTS margin_bottom_mobile integer;

-- Ask PostgREST to reload its schema cache so the new columns are
-- immediately addressable through the REST API used by the admin editor
-- (`base44.entities.TypographyStyle`) and the public typography endpoint.
NOTIFY pgrst, 'reload schema';

COMMIT;
