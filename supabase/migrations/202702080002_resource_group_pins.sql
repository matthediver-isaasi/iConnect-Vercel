BEGIN;
ALTER TABLE public.resource
  ADD COLUMN IF NOT EXISTS is_group_pinned boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.resource.is_group_pinned IS
  'Editorial ordering within the owning member group only; never grants access or library priority.';
COMMIT;
