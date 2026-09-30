-- Configurable role badge colours.
--
-- Adds two per-role colour fields used to render a role's name badge
-- consistently across every surface (members list, team/directory cards,
-- member detail views, member role report, etc). When unset, surfaces fall
-- back to a neutral default badge style.
--
--   badge_background_colour : CSS colour (hex) used as the badge background
--   badge_text_colour       : CSS colour (hex) used as the badge text
--
-- Idempotent: safe to run multiple times.

ALTER TABLE role ADD COLUMN IF NOT EXISTS badge_background_colour TEXT;
ALTER TABLE role ADD COLUMN IF NOT EXISTS badge_text_colour TEXT;
