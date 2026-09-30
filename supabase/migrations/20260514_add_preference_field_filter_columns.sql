-- Add filter-related columns to preference_field.
--
-- The Custom Fields admin UI writes `is_filterable` and `filter_multi_select`
-- when saving picklist/dropdown/country/countries custom fields, but no prior
-- migration added these columns. Saving currently fails with:
--   "Could not find the 'filter_multi_select' column of 'preference_field'
--    in the schema cache".
--
-- Default both flags to false so existing rows keep their current
-- (non-filterable) behavior until an admin opts in.

ALTER TABLE preference_field
  ADD COLUMN IF NOT EXISTS is_filterable BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS filter_multi_select BOOLEAN DEFAULT false;

-- Nudge PostgREST to reload its schema cache so the new columns are
-- immediately visible to the API.
NOTIFY pgrst, 'reload schema';
