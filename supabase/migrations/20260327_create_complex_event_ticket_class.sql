-- Create complex_event_ticket_class table for track-linked ticketing on complex events
-- Each ticket class belongs to a complex event and can grant access to specific tracks or all tracks

CREATE TABLE IF NOT EXISTS complex_event_ticket_class (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenant(id),
  complex_event_id UUID NOT NULL REFERENCES complex_event(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  price NUMERIC(10, 2) NOT NULL DEFAULT 0,
  is_free BOOLEAN NOT NULL DEFAULT false,

  -- Early bird pricing
  early_bird_enabled BOOLEAN NOT NULL DEFAULT false,
  early_bird_price NUMERIC(10, 2),
  early_bird_deadline TIMESTAMP WITH TIME ZONE,

  -- Group ticket options
  is_group_ticket BOOLEAN NOT NULL DEFAULT false,
  group_size INTEGER,
  group_cutoff_date TIMESTAMP WITH TIME ZONE,

  -- VAT configuration (Xero integration)
  vat_rate_key VARCHAR(255),
  vat_rate_label VARCHAR(255),
  vat_rate_percentage NUMERIC(5, 2),

  -- Visibility and role restrictions
  visibility_mode VARCHAR(50) NOT NULL DEFAULT 'members_only',
  role_ids JSONB DEFAULT '[]',
  role_match_only BOOLEAN NOT NULL DEFAULT false,

  -- Special offers
  offer_type VARCHAR(50) NOT NULL DEFAULT 'none',
  bogo_logic_type VARCHAR(50) DEFAULT 'buy_x_get_y_free',
  bogo_buy_quantity INTEGER,
  bogo_get_free_quantity INTEGER,
  bulk_discount_threshold INTEGER,
  bulk_discount_percentage NUMERIC(5, 2),

  -- Capacity
  available_count INTEGER,
  is_unlimited_tickets BOOLEAN NOT NULL DEFAULT true,

  -- Track linking
  linked_track_ids JSONB DEFAULT '[]',
  all_tracks BOOLEAN NOT NULL DEFAULT true,

  -- Display ordering
  display_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE complex_event_ticket_class IS 'Ticket classes for complex (multi-track) events with track-based access control';
COMMENT ON COLUMN complex_event_ticket_class.linked_track_ids IS 'Array of complex_event_track IDs this ticket grants access to';
COMMENT ON COLUMN complex_event_ticket_class.all_tracks IS 'When true, this ticket grants access to all tracks regardless of linked_track_ids';
COMMENT ON COLUMN complex_event_ticket_class.visibility_mode IS 'members_only, members_and_public, or public_only';
COMMENT ON COLUMN complex_event_ticket_class.offer_type IS 'none, bogo, or bulk_discount';
COMMENT ON COLUMN complex_event_ticket_class.role_ids IS 'Array of role UUIDs that can purchase this ticket. Empty array means all roles.';
COMMENT ON COLUMN complex_event_ticket_class.available_count IS 'Number of tickets available. NULL when is_unlimited_tickets is true.';

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_complex_event_ticket_class_tenant_id
  ON complex_event_ticket_class(tenant_id);

CREATE INDEX IF NOT EXISTS idx_complex_event_ticket_class_complex_event_id
  ON complex_event_ticket_class(complex_event_id);

CREATE INDEX IF NOT EXISTS idx_complex_event_ticket_class_event_order
  ON complex_event_ticket_class(complex_event_id, display_order);

-- Enable RLS
ALTER TABLE complex_event_ticket_class ENABLE ROW LEVEL SECURITY;

-- RLS policy: allow all operations for authenticated users within their tenant
CREATE POLICY "complex_event_ticket_class_tenant_isolation"
  ON complex_event_ticket_class
  FOR ALL
  USING (true)
  WITH CHECK (true);
