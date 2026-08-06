-- Event Budget tab: budgeted figures on both event tables + itemised actual cost lines.
-- Idempotent — safe to re-run.

ALTER TABLE event ADD COLUMN IF NOT EXISTS budgeted_costs numeric;
ALTER TABLE event ADD COLUMN IF NOT EXISTS budgeted_income numeric;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS budgeted_costs numeric;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS budgeted_income numeric;

CREATE TABLE IF NOT EXISTS event_cost_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- Works for both event kinds: event.id or complex_event.id, discriminated by event_kind.
  event_id uuid NOT NULL,
  event_kind text NOT NULL DEFAULT 'simple',
  description text,
  cost_type text,
  quantity numeric NOT NULL DEFAULT 1,
  unit_cost numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_cost_line_tenant_event
  ON event_cost_line (tenant_id, event_id);
