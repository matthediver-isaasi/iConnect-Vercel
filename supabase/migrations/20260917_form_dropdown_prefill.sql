-- Persist the top-level Organisation / Organisation Group dropdown that drives
-- reactive form prefill. The selected field remains part of the form's JSON
-- field definition; this column stores only its stable field ID.
ALTER TABLE public.form
  ADD COLUMN IF NOT EXISTS prefill_source_field_id text;