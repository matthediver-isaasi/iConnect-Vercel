-- Create member_resource_category join table for storing member category/interest selections
-- This is a many-to-many relationship between members and resource categories
-- Run this SQL in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS member_resource_category (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  resource_category_id UUID NOT NULL REFERENCES resource_category(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(member_id, resource_category_id)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_member_resource_category_member ON member_resource_category(member_id);
CREATE INDEX IF NOT EXISTS idx_member_resource_category_category ON member_resource_category(resource_category_id);

-- Enable RLS
ALTER TABLE member_resource_category ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can manage all records
CREATE POLICY "Service role can manage member_resource_category" ON member_resource_category
  FOR ALL USING (auth.role() = 'service_role');

-- Policy: Members can read their own category selections
CREATE POLICY "Members can read own category selections" ON member_resource_category
  FOR SELECT USING (auth.uid()::text = member_id::text);
