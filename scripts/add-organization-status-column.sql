-- Migration: Add status column to organization table
-- Run this SQL in your Supabase SQL Editor

-- Add status column to organization table
ALTER TABLE organization 
ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';

-- Optionally update any existing organizations to have 'active' status
UPDATE organization SET status = 'active' WHERE status IS NULL;
