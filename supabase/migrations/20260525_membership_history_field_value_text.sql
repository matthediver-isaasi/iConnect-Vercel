-- field_value on membership history tables is informational (band matching uses band_id).
-- Picklist / multi-select fields legitimately store non-numeric values like
-- "Less than 1 Million USD", which break the previous numeric type at insert time
-- (Postgres 22P02). Widen to text to support all field types. Idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organisation_membership_history'
      AND column_name = 'field_value'
      AND data_type = 'numeric'
  ) THEN
    ALTER TABLE organisation_membership_history
      ALTER COLUMN field_value TYPE text USING field_value::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'member_membership_history'
      AND column_name = 'field_value'
      AND data_type = 'numeric'
  ) THEN
    ALTER TABLE member_membership_history
      ALTER COLUMN field_value TYPE text USING field_value::text;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
