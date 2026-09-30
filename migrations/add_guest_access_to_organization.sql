-- Add per-organisation Guest Access controls.
-- Lets each org admin opt their org in to accepting guests and override the
-- tenant-level default access period.
--
-- guest_access_enabled:        TRUE if guests are allowed to join this org.
--                              When FALSE (or NULL) the org behaves as if
--                              guests are off regardless of the tenant master
--                              switch.
-- guest_access_period_days:    Number of days for the org's guest access
--                              period override. NULL means "inherit tenant
--                              default" or, when guest_access_unlimited is
--                              TRUE, "no expiry" (Permanent).
-- guest_access_unlimited:      TRUE if the org's override is "Unlimited"
--                              (Permanent).
--
-- These fields are only meaningful when the tenant-level Guest Access master
-- switch (system_settings.guest_access.enabled) is also TRUE.

ALTER TABLE organization
  ADD COLUMN IF NOT EXISTS guest_access_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE organization
  ADD COLUMN IF NOT EXISTS guest_access_period_days INTEGER;

ALTER TABLE organization
  ADD COLUMN IF NOT EXISTS guest_access_unlimited BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN organization.guest_access_enabled IS 'True if this org accepts guest sign-ups (gated by tenant-level guest access master switch)';
COMMENT ON COLUMN organization.guest_access_period_days IS 'Per-org override for default guest access period in days; NULL means inherit tenant default (or no expiry when guest_access_unlimited is TRUE)';
COMMENT ON COLUMN organization.guest_access_unlimited IS 'True if the org overrides the default to Unlimited (Permanent) guest access';
