-- Migration: Add email and address fields to organization table
-- Run this in Supabase SQL Editor

-- Add email column for general organization email
ALTER TABLE organization 
ADD COLUMN IF NOT EXISTS email text;

-- Add address column as JSONB for composite address storage
-- Structure: { line1, line2, city, region, postcode, country }
ALTER TABLE organization 
ADD COLUMN IF NOT EXISTS address jsonb;

-- Add website column (the code uses 'website' but schema has 'website_url')
-- We'll add 'website' and keep 'website_url' for backward compatibility
ALTER TABLE organization 
ADD COLUMN IF NOT EXISTS website text;

-- Optional: Migrate existing website_url data to website column
UPDATE organization 
SET website = website_url 
WHERE website IS NULL AND website_url IS NOT NULL;
