-- Allow the new 'list' widget type on dashboard_widget.
-- Idempotent: drops and recreates the check constraint with the full set.
ALTER TABLE dashboard_widget
  DROP CONSTRAINT IF EXISTS dashboard_widget_widget_type_check;

ALTER TABLE dashboard_widget
  ADD CONSTRAINT dashboard_widget_widget_type_check
  CHECK (widget_type::text = ANY (ARRAY[
    'stat'::character varying,
    'bar'::character varying,
    'pie'::character varying,
    'donut'::character varying,
    'line'::character varying,
    'list'::character varying
  ]::text[]));
