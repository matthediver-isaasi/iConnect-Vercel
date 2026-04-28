-- Add guest access fields to the member table
-- Used by the tenant-level Guest Access feature so members who join via the
-- (future) guest sign-up flow can be distinguished from regular members and
-- have an individual access expiry date.
--
-- is_guest:           TRUE if this member is a guest (vs a regular member).
-- guest_expires_at:   Timestamp when the guest's access ends. NULL on a guest
--                     means "Permanent" (no expiry). A past timestamp means
--                     the guest is "Expired" — login is blocked at auth time.
-- Regular members ignore both fields entirely.

ALTER TABLE member
  ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE member
  ADD COLUMN IF NOT EXISTS guest_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN member.is_guest IS 'True if this member joined via the Guest Access sign-up flow';
COMMENT ON COLUMN member.guest_expires_at IS 'Guest access expiry timestamp; NULL means permanent (only meaningful when is_guest = TRUE)';

-- Helpful index for any future expiry sweeps / dashboards.
CREATE INDEX IF NOT EXISTS idx_member_guest_expiry
  ON member (guest_expires_at)
  WHERE is_guest = TRUE;
