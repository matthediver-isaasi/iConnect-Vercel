BEGIN;
ALTER TABLE public.resource_author_settings
  ADD COLUMN IF NOT EXISTS subcategory_filter_mode text NOT NULL DEFAULT 'or'
  CHECK (subcategory_filter_mode IN ('or', 'and'));
NOTIFY pgrst, 'reload schema';
COMMIT;
