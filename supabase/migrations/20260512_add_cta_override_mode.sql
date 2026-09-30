-- Add cta_override_mode to event and complex_event tables.
-- Also add cta_override_url to complex_event (it only existed on event before).
-- 'card'         -> existing behavior: card CTA links to override URL.
-- 'detail_page'  -> card links to event detail page; on detail page,
--                   booking inputs are hidden and a "Continue to book"
--                   button links to the override URL.

ALTER TABLE event
  ADD COLUMN IF NOT EXISTS cta_override_mode TEXT NOT NULL DEFAULT 'card'
    CHECK (cta_override_mode IN ('card','detail_page'));

ALTER TABLE complex_event
  ADD COLUMN IF NOT EXISTS cta_override_url TEXT;

ALTER TABLE complex_event
  ADD COLUMN IF NOT EXISTS cta_override_mode TEXT NOT NULL DEFAULT 'card'
    CHECK (cta_override_mode IN ('card','detail_page'));
