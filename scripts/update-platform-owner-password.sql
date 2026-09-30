-- Update platform owner password
-- Replace the placeholder values before running:
--   YOUR_EMAIL_HERE: The platform owner's email address
--   YOUR_NEW_PASSWORD_HERE: The new password (plain text - will be hashed)

UPDATE platform_owner
SET password_hash = crypt('YOUR_NEW_PASSWORD_HERE', gen_salt('bf', 12))
WHERE email = 'YOUR_EMAIL_HERE';

-- Verify the update was successful (returns 1 row if found)
SELECT id, email, name, is_active, updated_at 
FROM platform_owner 
WHERE email = 'YOUR_EMAIL_HERE';
