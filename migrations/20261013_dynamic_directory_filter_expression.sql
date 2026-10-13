-- Additive: NULL retains the historical single field/value condition.
ALTER TABLE public.dynamic_directory
  ADD COLUMN IF NOT EXISTS filter_expression jsonb;
COMMENT ON COLUMN public.dynamic_directory.filter_expression IS
  'Versioned inclusion expression; non-null expressions are authoritative over legacy filter columns.';
