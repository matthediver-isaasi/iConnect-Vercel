-- Membership tier reminder schedules: configurable email reminders
-- sent before/after the renewal date, targeted at specific member roles.

CREATE TABLE IF NOT EXISTS membership_tier_reminder (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  config_id uuid NOT NULL REFERENCES membership_tier_config(id) ON DELETE CASCADE,
  label text,
  offset_value integer NOT NULL DEFAULT 0,
  offset_unit text NOT NULL DEFAULT 'days',
  direction text NOT NULL DEFAULT 'before',
  email_template_id uuid REFERENCES email_template(id) ON DELETE SET NULL,
  recipient_role_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_tier_reminder_offset_unit_check
    CHECK (offset_unit IN ('days', 'weeks')),
  CONSTRAINT membership_tier_reminder_direction_check
    CHECK (direction IN ('before', 'after')),
  CONSTRAINT membership_tier_reminder_offset_value_check
    CHECK (offset_value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_membership_tier_reminder_config
  ON membership_tier_reminder(config_id);
CREATE INDEX IF NOT EXISTS idx_membership_tier_reminder_tenant
  ON membership_tier_reminder(tenant_id);

ALTER TABLE membership_tier_reminder ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS membership_tier_reminder_tenant_isolation ON membership_tier_reminder;
CREATE POLICY membership_tier_reminder_tenant_isolation ON membership_tier_reminder
  USING (true) WITH CHECK (true);

-- Per-target send log so each reminder fires exactly once per renewal cycle.
CREATE TABLE IF NOT EXISTS membership_tier_reminder_send (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  reminder_id uuid NOT NULL REFERENCES membership_tier_reminder(id) ON DELETE CASCADE,
  membership_year text NOT NULL,
  scope_type text NOT NULL,
  organization_id uuid,
  member_id uuid,
  recipient_email text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'sent',
  error text,
  CONSTRAINT membership_tier_reminder_send_scope_check
    CHECK (scope_type IN ('organization', 'member'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_tier_reminder_send_org
  ON membership_tier_reminder_send(reminder_id, membership_year, organization_id)
  WHERE organization_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_tier_reminder_send_member
  ON membership_tier_reminder_send(reminder_id, membership_year, member_id)
  WHERE member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_membership_tier_reminder_send_tenant
  ON membership_tier_reminder_send(tenant_id);

ALTER TABLE membership_tier_reminder_send ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS membership_tier_reminder_send_tenant_isolation ON membership_tier_reminder_send;
CREATE POLICY membership_tier_reminder_send_tenant_isolation ON membership_tier_reminder_send
  USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
