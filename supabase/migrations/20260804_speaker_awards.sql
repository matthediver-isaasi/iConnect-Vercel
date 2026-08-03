-- Task #3285: speaker awards (training vouchers + library badges) granted
-- automatically when an event starts.
-- Idempotent: safe to run repeatedly.

-- Award configuration stored per event (default award + per-speaker overrides).
ALTER TABLE event
  ADD COLUMN IF NOT EXISTS speaker_award_config JSONB,
  ADD COLUMN IF NOT EXISTS speaker_awards_granted_at TIMESTAMPTZ;

ALTER TABLE complex_event
  ADD COLUMN IF NOT EXISTS speaker_award_config JSONB,
  ADD COLUMN IF NOT EXISTS speaker_awards_granted_at TIMESTAMPTZ;

-- Badge library assignment to members (minimal; reusable by later admin
-- badge-awarding work).
CREATE TABLE IF NOT EXISTS public.member_badge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  badge_id UUID NOT NULL REFERENCES badge(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT,          -- e.g. 'speaker_award'
  source_ref TEXT,      -- e.g. '<event_type>:<event_id>'
  created_by TEXT,
  UNIQUE (badge_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_member_badge_tenant ON public.member_badge (tenant_id);
CREATE INDEX IF NOT EXISTS idx_member_badge_member ON public.member_badge (member_id);

-- Per-speaker grant log (also the idempotency guard for the cron).
CREATE TABLE IF NOT EXISTS public.speaker_award_grant (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('event', 'complex_event')),
  event_id UUID NOT NULL,
  speaker_id UUID NOT NULL,
  speaker_name TEXT,
  member_id UUID,
  organization_id UUID,
  status TEXT NOT NULL,          -- pending | granted | skipped_excluded | skipped_no_member | skipped_no_award
  voucher_id UUID,
  voucher_value NUMERIC,
  badge_id UUID,
  member_badge_id UUID,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_type, event_id, speaker_id)
);
CREATE INDEX IF NOT EXISTS idx_speaker_award_grant_event ON public.speaker_award_grant (event_type, event_id);
CREATE INDEX IF NOT EXISTS idx_speaker_award_grant_tenant ON public.speaker_award_grant (tenant_id);
