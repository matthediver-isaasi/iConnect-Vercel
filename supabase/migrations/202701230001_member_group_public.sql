-- Publication is explicit and independent of joining and directory visibility.
ALTER TABLE public.member_group
  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.member_group.is_public IS
  'Explicit consent for scoped read-only guest group content, resources and forum discussions.';
