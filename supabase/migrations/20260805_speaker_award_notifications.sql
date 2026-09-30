-- Task #3287: notification emails for speaker award grants.
--
-- notified_at             — all required notifications delivered (overall done; sweep filter)
-- member_notified_at      — speaker/member email DELIVERED (set only after a confirmed send)
-- org_notified_at         — organisation billing email DELIVERED (confirmed send)
-- member_notify_lease_at  — in-flight send lease for the member email (expires; stealable)
-- org_notify_lease_at     — in-flight send lease for the organisation email
ALTER TABLE speaker_award_grant
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS member_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS org_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS member_notify_lease_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS org_notify_lease_at TIMESTAMPTZ;

-- The cron sweep repeatedly queries granted-but-unnotified rows.
CREATE INDEX IF NOT EXISTS idx_speaker_award_grant_unnotified
  ON speaker_award_grant (status)
  WHERE status = 'granted' AND notified_at IS NULL;
