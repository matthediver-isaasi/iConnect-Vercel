-- Allow `fifth` widget width (task #607)
--
-- Relaxes the dashboard_widget.width CHECK constraint to include
-- 'fifth' (col-span-2 on the 12-col grid) so 5-card top-row KPI
-- layouts insert cleanly. Wrapped in a guard so it is safe to run on
-- a fresh database where create_dashboard_widget.sql has not yet
-- created the table — the constraint will simply be defined with the
-- new value set when that migration runs.

DO $$
BEGIN
  IF to_regclass('public.dashboard_widget') IS NOT NULL THEN
    ALTER TABLE dashboard_widget
      DROP CONSTRAINT IF EXISTS dashboard_widget_width_check;
    ALTER TABLE dashboard_widget
      ADD CONSTRAINT dashboard_widget_width_check
      CHECK (width IN ('fifth', 'third', 'half', 'full'));
  END IF;
END $$;
