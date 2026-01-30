-- Migration: Add zoho_list_id column to communication_category table
-- This allows mapping communication categories to Zoho Campaigns mailing lists

-- Add the zoho_list_id column (nullable - not all categories need to be mapped)
ALTER TABLE communication_category 
ADD COLUMN IF NOT EXISTS zoho_list_id TEXT;

-- Add an index for lookup by zoho_list_id
CREATE INDEX IF NOT EXISTS idx_communication_category_zoho_list_id 
ON communication_category(zoho_list_id) 
WHERE zoho_list_id IS NOT NULL;

-- Add a comment explaining the column
COMMENT ON COLUMN communication_category.zoho_list_id IS 'Zoho Campaigns list ID for syncing subscribers';
