-- Fix organization_preference_value records with extra quotes
-- For the Organisation Type field (e5ac547d-edb1-4ff1-83ab-fc82c1813065)

-- Remove the surrounding quotes from the value column
UPDATE organization_preference_value
SET value = TRIM(BOTH '"' FROM value)
WHERE field_id = 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'
  AND value LIKE '"%"';

-- Verify the fix
SELECT value, COUNT(*) 
FROM organization_preference_value 
WHERE field_id = 'e5ac547d-edb1-4ff1-83ab-fc82c1813065'
GROUP BY value
ORDER BY COUNT(*) DESC;
