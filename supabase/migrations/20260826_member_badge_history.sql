-- Preserve member badge award history while allowing a revoked badge to be
-- awarded again. Actor labels are snapshotted so audit history remains
-- understandable even if the actor account is later renamed or removed.

ALTER TABLE public.member_badge
  ADD COLUMN IF NOT EXISTS awarded_by_type TEXT,
  ADD COLUMN IF NOT EXISTS awarded_by_id UUID,
  ADD COLUMN IF NOT EXISTS awarded_by_label TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by_type TEXT,
  ADD COLUMN IF NOT EXISTS revoked_by_id UUID,
  ADD COLUMN IF NOT EXISTS revoked_by_label TEXT;

UPDATE public.member_badge
SET
  awarded_by_type = CASE
    WHEN created_by = 'system:speaker-awards' OR source = 'speaker_award' THEN 'system'
    ELSE 'legacy'
  END,
  awarded_by_label = CASE
    WHEN created_by = 'system:speaker-awards' OR source = 'speaker_award'
      THEN 'Speaker awards automation'
    WHEN NULLIF(created_by, '') IS NOT NULL THEN created_by
    ELSE 'Legacy award'
  END
WHERE awarded_by_type IS NULL OR awarded_by_label IS NULL;

ALTER TABLE public.member_badge
  ALTER COLUMN awarded_by_type SET DEFAULT 'legacy';

ALTER TABLE public.member_badge
  DROP CONSTRAINT IF EXISTS member_badge_badge_id_member_id_key;

-- Badge definitions that have assignment history must be deactivated rather
-- than deleted, otherwise the existing ON DELETE CASCADE would erase the audit
-- trail this migration is designed to preserve.
ALTER TABLE public.member_badge
  DROP CONSTRAINT IF EXISTS member_badge_badge_id_fkey;
ALTER TABLE public.member_badge
  ADD CONSTRAINT member_badge_badge_id_fkey
  FOREIGN KEY (badge_id) REFERENCES public.badge(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_member_badge_active
  ON public.member_badge (tenant_id, member_id, badge_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_member_badge_history
  ON public.member_badge (tenant_id, member_id, awarded_at DESC);
