-- Add `updated_at` to public.member.
--
-- The `member_preference_value` parent-watermark trigger added in
-- 20260425_zoho_pref_value_bumps_parent.sql does:
--   UPDATE member SET updated_at = NOW() WHERE id = ...;
-- but `member` only had `created_on` — no `updated_at`. As a result,
-- every INSERT / UPDATE / DELETE on `member_preference_value` since
-- 2026-04-25 has been failing with `column "updated_at" of relation
-- "member" does not exist`, which the form processor swallowed silently
-- (see api/forms/process-application.js custom-field upsert loops).
--
-- This migration adds the missing column, backfills it from `created_on`,
-- installs a BEFORE UPDATE trigger that keeps it fresh on every write,
-- and asks PostgREST to reload its schema cache so the new column is
-- visible to the API layer immediately.

-- Add the column nullable first so we can seed it from `created_on` without
-- pretending every existing member was "updated" at migration time, then
-- enforce NOT NULL with a default for future inserts.
ALTER TABLE public.member
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE public.member
SET updated_at = COALESCE(created_on, NOW())
WHERE updated_at IS NULL;

ALTER TABLE public.member
  ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE public.member
  ALTER COLUMN updated_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.set_member_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_member_set_updated_at ON public.member;
CREATE TRIGGER trg_member_set_updated_at
BEFORE UPDATE ON public.member
FOR EACH ROW EXECUTE FUNCTION public.set_member_updated_at();

COMMENT ON COLUMN public.member.updated_at IS
  'Last write timestamp. Maintained by trg_member_set_updated_at on direct writes, and bumped indirectly by trg_member_pref_value_bump_parent when member_preference_value rows change (Zoho outbound reconcile watermark).';

-- Reload PostgREST schema cache so the column is visible to the API layer
-- without a manual restart.
NOTIFY pgrst, 'reload schema';
