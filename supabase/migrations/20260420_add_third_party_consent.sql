-- Add third-party data sharing consent toggle (organiser-controlled) for complex events
-- and a per-booking consent value column for both single and complex bookings.
--
-- For SINGLE events the organiser-side toggle is stored in event.pricing_config JSON
-- (under the key collectThirdPartyConsent) and so requires no schema change.
--
-- For COMPLEX events we follow the same "config JSON" persistence pattern and store
-- the toggle under pricing_config.collectThirdPartyConsent. complex_event has no
-- existing pricing_config column, so we add one as JSONB instead of adding a
-- per-toggle boolean column.

ALTER TABLE complex_event
  ADD COLUMN IF NOT EXISTS pricing_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE booking
  ADD COLUMN IF NOT EXISTS third_party_consent BOOLEAN;

ALTER TABLE complex_event_booking
  ADD COLUMN IF NOT EXISTS third_party_consent BOOLEAN;
