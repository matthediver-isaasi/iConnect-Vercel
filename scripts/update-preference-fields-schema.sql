-- Migration: Add entity_scope to preference_field and create organization_preference_value table
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Add entity_scope column to preference_field table
ALTER TABLE preference_field 
ADD COLUMN IF NOT EXISTS entity_scope VARCHAR(20) DEFAULT 'member' 
CHECK (entity_scope IN ('member', 'organization'));

-- Step 2: Update existing records to have 'member' scope (they were all member fields before)
UPDATE preference_field SET entity_scope = 'member' WHERE entity_scope IS NULL;

-- Step 3: Create organization_preference_value table for storing organization-specific values
CREATE TABLE IF NOT EXISTS organization_preference_value (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  field_id UUID NOT NULL REFERENCES preference_field(id) ON DELETE CASCADE,
  value TEXT, -- Stored as text, parsed based on field_type
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, field_id)
);

-- Step 4: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_preference_field_scope ON preference_field(entity_scope, is_active, display_order);
CREATE INDEX IF NOT EXISTS idx_organization_preference_value_org ON organization_preference_value(organization_id);
CREATE INDEX IF NOT EXISTS idx_organization_preference_value_field ON organization_preference_value(field_id);

-- Step 5: Enable RLS on organization_preference_value
ALTER TABLE organization_preference_value ENABLE ROW LEVEL SECURITY;

-- Step 6: RLS Policies for organization_preference_value

-- Policy: Authenticated users can read organization preference values (for directory display)
CREATE POLICY "Anyone can read organization preference values" ON organization_preference_value
  FOR SELECT USING (true);

-- Policy: Service role can manage all organization preference values (for admin operations)
CREATE POLICY "Service role can manage organization preference values" ON organization_preference_value
  FOR ALL USING (auth.role() = 'service_role');
