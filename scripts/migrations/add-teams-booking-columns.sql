-- Add Teams meeting support to agent_booking table
-- Run this in Supabase SQL Editor

ALTER TABLE agent_booking
ADD COLUMN IF NOT EXISTS teams_join_url VARCHAR;
