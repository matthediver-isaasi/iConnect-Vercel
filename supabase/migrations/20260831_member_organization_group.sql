-- Direct Organisation Group assignment for members without an Organisation.
-- Idempotent and safe to replay against the destination database.

ALTER TABLE public.member
  ADD COLUMN IF NOT EXISTS organization_group_id uuid
    REFERENCES public.organization_group(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.member.organization_group_id IS
  'Direct Organisation Group assignment for members without an Organisation. '
  'When an Organisation is assigned, the effective Group is derived from '
  'organization.organization_group_id instead.';

CREATE INDEX IF NOT EXISTS member_organization_group_id_idx
  ON public.member (organization_group_id)
  WHERE organization_group_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';