-- Add match_value column to membership_tier_band to support text/select custom fields as tier basis.
-- For text-basis bands each row stores a single option string instead of a min/max numeric range.
ALTER TABLE membership_tier_band
  ADD COLUMN IF NOT EXISTS match_value text;

-- Numeric bands continue to use min_value; text bands store NULL there. Drop the NOT NULL
-- constraint if one is present so text-basis bands can be inserted without a numeric range.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'membership_tier_band'
      AND column_name = 'min_value'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE membership_tier_band ALTER COLUMN min_value DROP NOT NULL;
  END IF;
END $$;
