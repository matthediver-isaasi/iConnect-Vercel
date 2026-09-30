-- Task #2304: Guided AI help-content generation.
-- Remembers the last-used free-text generation instructions for a page so a
-- later rebuild starts from them rather than a blank box. Nullable; empty/NULL
-- means no remembered instructions. Idempotent; safe to re-run.

ALTER TABLE help_article
  ADD COLUMN IF NOT EXISTS generation_instructions text;
