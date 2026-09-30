-- Create preference_field table for storing custom field definitions
-- Run this SQL in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS preference_field (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  label VARCHAR(255) NOT NULL,
  field_type VARCHAR(50) NOT NULL CHECK (field_type IN ('text', 'number', 'decimal', 'picklist', 'dropdown')),
  options JSONB, -- For picklist/dropdown: array of {value, label} objects
  is_required BOOLEAN DEFAULT false,
  is_filterable BOOLEAN DEFAULT false,
  filter_multi_select BOOLEAN DEFAULT false,
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create member_preference_value table for storing member-specific values
CREATE TABLE IF NOT EXISTS member_preference_value (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  field_id UUID NOT NULL REFERENCES preference_field(id) ON DELETE CASCADE,
  value TEXT, -- Stored as text, parsed based on field_type
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(member_id, field_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_preference_field_active ON preference_field(is_active, display_order);
CREATE INDEX IF NOT EXISTS idx_member_preference_value_member ON member_preference_value(member_id);
CREATE INDEX IF NOT EXISTS idx_member_preference_value_field ON member_preference_value(field_id);

-- Add RLS policies (adjust based on your security requirements)
ALTER TABLE preference_field ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_preference_value ENABLE ROW LEVEL SECURITY;

-- Policy: Authenticated users can read active preference fields
CREATE POLICY "Anyone can read active preference fields" ON preference_field
  FOR SELECT USING (is_active = true);

-- Policy: Service role can manage preference fields (for admin operations)
CREATE POLICY "Service role can manage preference fields" ON preference_field
  FOR ALL USING (auth.role() = 'service_role');

-- Policy: Members can read their own preference values
CREATE POLICY "Members can read own preference values" ON member_preference_value
  FOR SELECT USING (auth.uid()::text = member_id::text);

-- Policy: Members can manage their own preference values
CREATE POLICY "Members can manage own preference values" ON member_preference_value
  FOR ALL USING (auth.uid()::text = member_id::text);

-- Policy: Service role can manage all preference values (for admin operations)
CREATE POLICY "Service role can manage all preference values" ON member_preference_value
  FOR ALL USING (auth.role() = 'service_role');
