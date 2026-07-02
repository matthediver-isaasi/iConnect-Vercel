-- Migration: Add storage_path to project_card_attachment and ensure cover_image exists on project_card
-- Run this in Supabase SQL Editor

-- Add storage_path column to track Supabase Storage location
ALTER TABLE project_card_attachment 
ADD COLUMN IF NOT EXISTS storage_path TEXT;

-- Add thumbnail_url for quick previews of images
ALTER TABLE project_card_attachment 
ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

-- Ensure cover_image column exists on project_card (for cover image URL)
-- This should already exist but adding IF NOT EXISTS for safety
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_card' AND column_name = 'cover_image'
  ) THEN
    ALTER TABLE project_card ADD COLUMN cover_image TEXT;
  END IF;
END $$;

-- Ensure cover_color column exists (for solid color covers)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_card' AND column_name = 'cover_color'
  ) THEN
    ALTER TABLE project_card ADD COLUMN cover_color VARCHAR(50);
  END IF;
END $$;

-- Create index on storage_path for efficient lookups
CREATE INDEX IF NOT EXISTS idx_project_card_attachment_storage_path 
ON project_card_attachment(storage_path);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON project_card_attachment TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_card_attachment TO anon;
