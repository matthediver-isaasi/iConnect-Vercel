-- Task #1561: Split the single member_group events toggle into independent
-- simple-event and complex-event flags.
--
-- The existing `events_enabled` column is now the SIMPLE-events flag. This adds
-- `complex_events_enabled` for the complex (multi-session) events flag.
--
-- Backfill: existing groups that had events enabled keep the ability to create
-- complex events too (no regression). The backfill runs ONLY when the column is
-- newly added, so re-running this migration never clobbers an admin's later
-- choice to turn complex events off while leaving simple events on.
-- Idempotent; safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'member_group'
      AND column_name = 'complex_events_enabled'
  ) THEN
    ALTER TABLE member_group
      ADD COLUMN complex_events_enabled BOOLEAN NOT NULL DEFAULT false;

    UPDATE member_group
      SET complex_events_enabled = true
      WHERE events_enabled = true;
  END IF;
END $$;
