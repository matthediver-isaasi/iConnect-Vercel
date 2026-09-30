-- Migration: Add organization_id column to form_submission table
-- This creates a direct link between form submissions and organizations
-- 
-- Purpose:
-- - Links forms to organizations when prefilled via URL (prefill_organization_id)
-- - Links forms to newly created organizations (after processing)
-- - Enables organization history view showing all form submissions for an org
--
-- Run this in your Supabase SQL Editor:

-- Add the organization_id column
ALTER TABLE form_submission 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organization(id);

-- Create an index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_form_submission_organization_id 
ON form_submission(organization_id);
