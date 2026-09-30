-- Support CSAT rating + auto-close of resolved tickets.
-- Idempotent: safe to re-run.
ALTER TABLE support_ticket ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE support_ticket ADD COLUMN IF NOT EXISTS satisfaction_rating INTEGER;
ALTER TABLE support_ticket ADD COLUMN IF NOT EXISTS satisfaction_comment TEXT;
ALTER TABLE support_ticket ADD COLUMN IF NOT EXISTS satisfaction_rated_at TIMESTAMPTZ;
ALTER TABLE support_ticket ADD COLUMN IF NOT EXISTS closed_reason TEXT;
ALTER TABLE support_ticket ADD COLUMN IF NOT EXISTS auto_close_warning_sent_at TIMESTAMPTZ;
