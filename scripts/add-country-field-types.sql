-- Migration: Add 'country' and 'countries' as valid field_types for preference_field
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Drop the existing check constraint
ALTER TABLE preference_field DROP CONSTRAINT IF EXISTS preference_field_field_type_check;

-- Step 2: Add the new check constraint with all valid field types
-- Note: This includes all existing types plus the new 'country' and 'countries' types
ALTER TABLE preference_field 
ADD CONSTRAINT preference_field_field_type_check 
CHECK (field_type IN ('text', 'email', 'url', 'date', 'boolean', 'number', 'decimal', 'picklist', 'dropdown', 'country', 'countries', 'list', 'file'));

-- Step 3: Add columns for country field configuration (if they don't exist)
-- These columns store the configuration for country/countries field types
ALTER TABLE preference_field ADD COLUMN IF NOT EXISTS all_countries boolean DEFAULT true;
ALTER TABLE preference_field ADD COLUMN IF NOT EXISTS selected_countries jsonb DEFAULT '[]'::jsonb;
ALTER TABLE preference_field ADD COLUMN IF NOT EXISTS default_country varchar(2);
ALTER TABLE preference_field ADD COLUMN IF NOT EXISTS default_countries jsonb DEFAULT '[]'::jsonb;
