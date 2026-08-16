-- Member membership pause (access + recurring payments suspended together).
-- Idempotent: safe to re-run.
ALTER TABLE member ADD COLUMN IF NOT EXISTS membership_paused BOOLEAN DEFAULT false;
ALTER TABLE member ADD COLUMN IF NOT EXISTS membership_paused_at TIMESTAMPTZ;
ALTER TABLE member ADD COLUMN IF NOT EXISTS membership_pause_restart_date DATE;
ALTER TABLE member ADD COLUMN IF NOT EXISTS membership_paused_by TEXT;
ALTER TABLE member ADD COLUMN IF NOT EXISTS membership_pause_reason TEXT;
ALTER TABLE member ADD COLUMN IF NOT EXISTS membership_pause_gc_subscriptions JSONB DEFAULT '[]'::jsonb;

-- Backfill: pre-existing rows are not paused.
UPDATE member SET membership_paused = false WHERE membership_paused IS NULL;
