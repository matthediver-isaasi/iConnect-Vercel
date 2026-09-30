-- Migration: Fix risk_level values with spaces
-- The backend was only replacing the first space with underscore, leaving other spaces.
-- This migration fixes existing records to replace ALL spaces with underscores.

-- Update all risk_level values that still contain spaces
UPDATE form_submission_due_diligence
SET risk_level = LOWER(REGEXP_REPLACE(risk_level, '\s+', '_', 'g'))
WHERE risk_level ~ '\s';

-- Verify the fix
SELECT DISTINCT risk_level, COUNT(*) as count
FROM form_submission_due_diligence
WHERE risk_level IS NOT NULL
GROUP BY risk_level
ORDER BY risk_level;
