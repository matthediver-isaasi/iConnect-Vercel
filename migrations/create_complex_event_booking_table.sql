-- Create complex_event_booking table for managing bookings/registrations for complex (multi-session) events
-- Stores attendee details, ticket class reference, payment info, and booking status

CREATE TABLE IF NOT EXISTS complex_event_booking (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    event_id UUID NOT NULL,
    booking_reference TEXT NOT NULL,
    attendee_email TEXT NOT NULL,
    attendee_first_name TEXT,
    attendee_last_name TEXT,
    attendee_organization TEXT,
    attendee_phone TEXT,
    attendee_job_title TEXT,
    member_id UUID,
    organization_id UUID,
    ticket_class_id TEXT,
    ticket_class_name TEXT,
    ticket_price NUMERIC(10,2) DEFAULT 0,
    payment_method TEXT DEFAULT 'free',
    payment_status TEXT DEFAULT 'pending',
    stripe_payment_intent_id TEXT,
    voucher_id UUID,
    voucher_amount NUMERIC(10,2) DEFAULT 0,
    training_fund_amount NUMERIC(10,2) DEFAULT 0,
    discount_code TEXT,
    discount_amount NUMERIC(10,2) DEFAULT 0,
    account_balance_amount NUMERIC(10,2) DEFAULT 0,
    total_paid NUMERIC(10,2) DEFAULT 0,
    currency TEXT DEFAULT 'gbp',
    status TEXT DEFAULT 'confirmed',
    notes TEXT,
    booking_group_reference TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ceb_tenant_id ON complex_event_booking(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ceb_event_id ON complex_event_booking(event_id);
CREATE INDEX IF NOT EXISTS idx_ceb_attendee_email ON complex_event_booking(attendee_email);
CREATE INDEX IF NOT EXISTS idx_ceb_booking_reference ON complex_event_booking(booking_reference);
CREATE INDEX IF NOT EXISTS idx_ceb_status ON complex_event_booking(status);
CREATE INDEX IF NOT EXISTS idx_ceb_member_id ON complex_event_booking(member_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ceb_event_email_unique 
    ON complex_event_booking(tenant_id, event_id, lower(attendee_email)) 
    WHERE status IN ('confirmed', 'pending');
CREATE UNIQUE INDEX IF NOT EXISTS idx_ceb_stripe_pi_unique
    ON complex_event_booking(stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;

COMMENT ON TABLE complex_event_booking IS 'Bookings/registrations for complex multi-session events';
COMMENT ON COLUMN complex_event_booking.event_id IS 'Reference to the parent event (event table with is_complex=true)';
COMMENT ON COLUMN complex_event_booking.booking_reference IS 'Human-readable booking reference code';
COMMENT ON COLUMN complex_event_booking.ticket_class_id IS 'ID of the ticket class from pricing_config';
COMMENT ON COLUMN complex_event_booking.payment_method IS 'Payment method: free, card, account, training_fund, voucher, mixed';
COMMENT ON COLUMN complex_event_booking.payment_status IS 'Payment status: pending, paid, failed, refunded';
COMMENT ON COLUMN complex_event_booking.status IS 'Booking status: confirmed, pending, cancelled';
