-- Existing rows and new rows default to both so rollout preserves visibility.
ALTER TABLE floater
  ADD COLUMN IF NOT EXISTS device_target text NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS audience_target text NOT NULL DEFAULT 'both';

ALTER TABLE floater
  DROP CONSTRAINT IF EXISTS floater_device_target_check,
  DROP CONSTRAINT IF EXISTS floater_audience_target_check;

ALTER TABLE floater
  ADD CONSTRAINT floater_device_target_check
    CHECK (device_target IN ('desktop', 'mobile', 'both')),
  ADD CONSTRAINT floater_audience_target_check
    CHECK (audience_target IN ('authenticated', 'public', 'both'));

COMMENT ON COLUMN floater.device_target IS
  'Responsive target: desktop (>=768px), mobile (<768px), or both.';
COMMENT ON COLUMN floater.audience_target IS
  'Validated-session audience: authenticated, public, or both.';