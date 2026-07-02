-- Migration: Add pin and flag columns to member_email table
-- Enables Outlook-style pinning (pin to top) and flagging of emails

ALTER TABLE member_email ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE member_email ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_member_email_pinned ON member_email(member_id, is_pinned) WHERE is_pinned = true;
