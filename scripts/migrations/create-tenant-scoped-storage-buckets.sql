-- Migration: Tenant-scoped storage helper functions
-- Purpose: Support functions for tenant-scoped file storage
-- 
-- IMPORTANT: Storage bucket policies must be configured through the Supabase Dashboard.
-- This file only contains optional helper functions.
--
-- Bucket Configuration (done via Supabase Dashboard):
-- 1. public-assets: Public bucket for branding, logos (publicly readable)
-- 2. private-uploads: Private bucket for form submissions, sensitive documents

-- =============================================================================
-- OPTIONAL: Helper function to extract tenant_id from storage path
-- =============================================================================
-- 
-- This function can be used in custom RLS policies if needed.
-- File paths follow the pattern: {tenant_id}/...
--
-- Note: If you get permission errors, you may need to create this in the 
-- public schema instead of storage schema.

CREATE OR REPLACE FUNCTION public.get_tenant_from_storage_path(path_to_check text)
RETURNS uuid AS $$
BEGIN
  -- Path format: {tenant_uuid}/...
  -- Extract everything before the first /
  RETURN CAST(split_part(path_to_check, '/', 1) AS uuid);
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- =============================================================================
-- DASHBOARD POLICY CONFIGURATION REFERENCE
-- =============================================================================
-- 
-- Configure these policies manually in Supabase Dashboard → Storage → [Bucket] → Policies:
--
-- FOR 'public-assets' BUCKET:
-- --------------------------
-- SELECT (Read): Allow public access
--   - Target roles: public (anon)
--   - Policy: true (or no restrictions)
--
-- INSERT (Upload): Authenticated users only, tenant-scoped
--   - Target roles: authenticated
--   - Policy expression: (bucket_id = 'public-assets')
--
-- UPDATE: Authenticated users only
--   - Target roles: authenticated  
--   - Policy expression: (bucket_id = 'public-assets')
--
-- DELETE: Authenticated users only
--   - Target roles: authenticated
--   - Policy expression: (bucket_id = 'public-assets')
--
--
-- FOR 'private-uploads' BUCKET:
-- -----------------------------
-- SELECT (Read): Authenticated users only
--   - Target roles: authenticated
--   - Policy expression: (bucket_id = 'private-uploads')
--
-- INSERT (Upload): Authenticated users only
--   - Target roles: authenticated
--   - Policy expression: (bucket_id = 'private-uploads')
--
-- UPDATE: Authenticated users only
--   - Target roles: authenticated
--   - Policy expression: (bucket_id = 'private-uploads')
--
-- DELETE: Authenticated users only
--   - Target roles: authenticated
--   - Policy expression: (bucket_id = 'private-uploads')
--
--
-- SECURITY NOTE:
-- -------------
-- The primary tenant isolation is enforced by the backend API endpoints:
-- - api/storage/tenant-upload.js - validates tenant context before upload
-- - api/storage/secure-url.js - validates tenant access before generating signed URLs
-- - api/storage/signed-upload-url.js - enforces tenant-scoped paths on uploads
--
-- The dashboard policies provide an additional layer of protection.
--
-- =============================================================================
-- FILE PATH STRUCTURE
-- =============================================================================
--
-- All file paths are scoped to tenant:
-- - {tenant_id}/branding/{filename} - logos, favicons
-- - {tenant_id}/pages/{page_id}/{filename} - page images  
-- - {tenant_id}/form-submissions/{form_id}/{submission_id}/{filename} - form uploads
-- - {tenant_id}/attachments/{entity_type}/{entity_id}/{filename} - general attachments
-- - {tenant_id}/uploads/{filename} - general uploads
