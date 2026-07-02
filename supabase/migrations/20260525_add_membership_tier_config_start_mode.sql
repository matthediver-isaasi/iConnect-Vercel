-- Add start_mode column to membership_tier_config
ALTER TABLE membership_tier_config
  ADD COLUMN IF NOT EXISTS start_mode text NOT NULL DEFAULT 'fixed_date';

ALTER TABLE membership_tier_config
  DROP CONSTRAINT IF EXISTS membership_tier_config_start_mode_check;

ALTER TABLE membership_tier_config
  ADD CONSTRAINT membership_tier_config_start_mode_check
  CHECK (start_mode IN ('fixed_date', 'immediate'));

NOTIFY pgrst, 'reload schema';
