BEGIN;
ALTER TABLE public.resource
  ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.resource.is_pinned IS
  'Tenant-wide editorial ordering only; never grants visibility or access.';
COMMIT;
