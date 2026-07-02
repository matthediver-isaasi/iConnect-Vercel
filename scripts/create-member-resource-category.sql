-- Create member_resource_category join table for storing member subcategory selections
-- Stores the parent category ID + subcategory name pairs
-- Run this SQL in your Supabase SQL Editor

-- Drop existing table if it exists (to recreate with new structure)
DROP TABLE IF EXISTS member_resource_category;

CREATE TABLE member_resource_category (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  resource_category_id UUID NOT NULL REFERENCES resource_category(id) ON DELETE CASCADE,
  subcategory_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(member_id, resource_category_id, subcategory_name)
);

-- Create indexes for efficient querying
CREATE INDEX idx_member_resource_category_member ON member_resource_category(member_id);
CREATE INDEX idx_member_resource_category_category ON member_resource_category(resource_category_id);

-- Enable RLS
ALTER TABLE member_resource_category ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can manage all records
CREATE POLICY "Service role can manage member_resource_category" ON member_resource_category
  FOR ALL USING (auth.role() = 'service_role');

-- Policy: Members can read their own category selections
CREATE POLICY "Members can read own category selections" ON member_resource_category
  FOR SELECT USING (auth.uid()::text = member_id::text);
