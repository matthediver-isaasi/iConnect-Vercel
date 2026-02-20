const SQL = `
-- Group Booking Tables for Event Group Tickets
-- A group ticket class has a set price covering multiple participants.
-- The booker receives a tokenised link to manage their group over time.

-- Table: event_group_booking
-- Stores the group booking record created after payment
CREATE TABLE IF NOT EXISTS event_group_booking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  ticket_class_id TEXT NOT NULL,
  booker_email TEXT NOT NULL,
  booker_first_name TEXT,
  booker_last_name TEXT,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  group_size INTEGER NOT NULL,
  stripe_payment_intent_id TEXT,
  booking_reference TEXT,
  payment_method TEXT,
  total_cost NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_group_booking_tenant ON event_group_booking(tenant_id);
CREATE INDEX IF NOT EXISTS idx_event_group_booking_event ON event_group_booking(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_group_booking_token ON event_group_booking(token);
CREATE INDEX IF NOT EXISTS idx_event_group_booking_booker ON event_group_booking(tenant_id, booker_email);

-- Table: event_group_booking_participant
-- Stores individual participants added to a group booking
CREATE TABLE IF NOT EXISTS event_group_booking_participant (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_booking_id UUID NOT NULL REFERENCES event_group_booking(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_egbp_booking ON event_group_booking_participant(group_booking_id);
CREATE INDEX IF NOT EXISTS idx_egbp_tenant ON event_group_booking_participant(tenant_id);
-- Unique constraint: no duplicate emails per group booking
CREATE UNIQUE INDEX IF NOT EXISTS idx_egbp_unique_email ON event_group_booking_participant(group_booking_id, LOWER(email));
`;

console.log('Please run the following SQL in Supabase SQL Editor:');
console.log('='.repeat(60));
console.log(SQL);
console.log('='.repeat(60));
