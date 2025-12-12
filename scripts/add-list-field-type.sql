-- Migration: Add 'list' as a valid field_type for preference_field
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Drop the existing check constraint
ALTER TABLE preference_field DROP CONSTRAINT IF EXISTS preference_field_field_type_check;

-- Step 2: Add the new check constraint with 'list' included
ALTER TABLE preference_field 
ADD CONSTRAINT preference_field_field_type_check 
CHECK (field_type IN ('text', 'number', 'decimal', 'picklist', 'dropdown', 'list'));
