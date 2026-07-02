-- Add area column to support_ticket for Support Areas feature
ALTER TABLE support_ticket ADD COLUMN IF NOT EXISTS area TEXT;
