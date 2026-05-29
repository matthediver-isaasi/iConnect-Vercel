-- Task #1156: Event QR entrance tickets & check-in.
--
-- In-person (offline) events get a per-attendee QR code that encodes a secure
-- staff check-in link. Complex (multi-track) events get one QR per registered
-- track/session. Online events get NO QR.
--
-- This migration adds:
--   1. check-in token + attendance columns on `booking` (regular events)
--   2. `complex_event_session_checkin` table (one token per booking+session)
--   3. `qr_on_confirmation` per-event toggle on `event` and `complex_event`
--   4. a one-off token backfill for confirmed attendees of offline,
--      not-yet-ended regular events.
--
-- Idempotent: safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Per-attendee check-in token + attendance on regular bookings.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS check_in_token TEXT;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS checked_in_by TEXT;

-- Partial unique index: tokens are unique when present, NULLs allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_check_in_token
  ON booking (check_in_token) WHERE check_in_token IS NOT NULL;

-- 2. Per-session check-in tokens for complex (multi-track) event bookings.
-- Created lazily by the application when a QR is first needed for a
-- (booking, session) pair; one opaque token each.
CREATE TABLE IF NOT EXISTS complex_event_session_checkin (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  complex_event_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  session_id UUID NOT NULL,
  token TEXT NOT NULL UNIQUE,
  checked_in_at TIMESTAMPTZ,
  checked_in_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ce_session_checkin_booking_session
  ON complex_event_session_checkin (booking_id, session_id);
CREATE INDEX IF NOT EXISTS idx_ce_session_checkin_token
  ON complex_event_session_checkin (token);
CREATE INDEX IF NOT EXISTS idx_ce_session_checkin_event
  ON complex_event_session_checkin (complex_event_id);

-- 3. Per-event toggle to auto-include the QR on booking confirmation emails.
-- Defaults TRUE; only ever takes effect for offline events.
ALTER TABLE event ADD COLUMN IF NOT EXISTS qr_on_confirmation BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS qr_on_confirmation BOOLEAN NOT NULL DEFAULT TRUE;

-- 4. Backfill tokens for confirmed attendees of offline, not-yet-ended events.
-- gen_random_bytes is volatile, so each row gets a distinct token.
UPDATE booking b
SET check_in_token = encode(gen_random_bytes(24), 'hex')
FROM event e
WHERE b.event_id = e.id
  AND b.check_in_token IS NULL
  AND b.status = 'confirmed'
  AND COALESCE(e.is_online, FALSE) = FALSE
  AND COALESCE(e.end_date, e.start_date) >= NOW();
