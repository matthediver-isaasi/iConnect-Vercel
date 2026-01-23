-- Migration: Create tenant-scoped storage buckets with RLS policies
-- Purpose: Isolate file storage per tenant for security
-- 
-- This creates two buckets:
-- 1. public-assets: For branding, logos, public page images (tenant-scoped but publicly readable)
-- 2. private-uploads: For form submissions, sensitive documents (tenant-scoped, authenticated access only)
--
-- Run this in Supabase SQL Editor

-- =============================================================================
-- STEP 1: Create the buckets (if they don't exist)
-- =============================================================================

-- Note: Buckets must be created via the Supabase Dashboard or API
-- The SQL below sets up the RLS policies once buckets exist

-- CREATE BUCKET 'public-assets':
-- - Public: false (we'll control access via RLS)
-- - File size limit: 10MB
-- - Allowed MIME types: image/*, application/pdf

-- CREATE BUCKET 'private-uploads':
-- - Public: false
-- - File size limit: 25MB
-- - Allowed MIME types: all

-- =============================================================================
-- STEP 2: Enable RLS on storage.objects
-- =============================================================================

-- RLS should already be enabled on storage.objects by Supabase
-- but let's ensure it
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- STEP 3: Create helper function to extract tenant_id from path
-- =============================================================================

-- File paths will follow the pattern: {tenant_id}/...
-- This function extracts the tenant_id from a storage path
CREATE OR REPLACE FUNCTION storage.get_tenant_from_path(path_to_check text)
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
-- STEP 4: Create helper function to check if user belongs to tenant
-- =============================================================================

-- This checks if the current authenticated user has access to a tenant
-- by checking tenant_membership or tenant_user tables
CREATE OR REPLACE FUNCTION storage.user_has_tenant_access(target_tenant_id uuid)
RETURNS boolean AS $$
DECLARE
  user_identity_id uuid;
  has_access boolean := false;
BEGIN
  -- Get the user's identity from the JWT claims
  user_identity_id := (auth.jwt() ->> 'sub')::uuid;
  
  IF user_identity_id IS NULL THEN
    RETURN false;
  END IF;
  
  -- Check tenant_membership for access
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_membership
    WHERE identity_id = user_identity_id
    AND tenant_id = target_tenant_id
    AND status = 'active'
  ) INTO has_access;
  
  IF has_access THEN
    RETURN true;
  END IF;
  
  -- Check tenant_user for direct tenant ownership
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_user
    WHERE identity_id = user_identity_id
    AND tenant_id = target_tenant_id
    AND status = 'active'
  ) INTO has_access;
  
  RETURN has_access;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- STEP 5: Drop existing policies if they exist
-- =============================================================================

DROP POLICY IF EXISTS "public_assets_tenant_read" ON storage.objects;
DROP POLICY IF EXISTS "public_assets_tenant_write" ON storage.objects;
DROP POLICY IF EXISTS "public_assets_tenant_delete" ON storage.objects;
DROP POLICY IF EXISTS "private_uploads_tenant_read" ON storage.objects;
DROP POLICY IF EXISTS "private_uploads_tenant_write" ON storage.objects;
DROP POLICY IF EXISTS "private_uploads_tenant_delete" ON storage.objects;

-- =============================================================================
-- STEP 6: Create RLS policies for 'public-assets' bucket
-- =============================================================================

-- Public assets are publicly READABLE (for branding/logos on public pages)
-- but only writable/deletable by authenticated users from that tenant
CREATE POLICY "public_assets_tenant_read"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'public-assets'
);

-- Only authenticated users can upload to their own tenant folder
CREATE POLICY "public_assets_tenant_write"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'public-assets'
  AND storage.user_has_tenant_access(storage.get_tenant_from_path(name))
);

-- Only authenticated users can update files in their own tenant folder
CREATE POLICY "public_assets_tenant_update"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'public-assets'
  AND storage.user_has_tenant_access(storage.get_tenant_from_path(name))
);

-- Only authenticated users can delete from their own tenant folder
CREATE POLICY "public_assets_tenant_delete"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'public-assets'
  AND storage.user_has_tenant_access(storage.get_tenant_from_path(name))
);

-- =============================================================================
-- STEP 7: Create RLS policies for 'private-uploads' bucket
-- =============================================================================

-- Private uploads are ONLY accessible by authenticated users from that tenant
CREATE POLICY "private_uploads_tenant_read"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'private-uploads'
  AND storage.user_has_tenant_access(storage.get_tenant_from_path(name))
);

CREATE POLICY "private_uploads_tenant_write"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'private-uploads'
  AND storage.user_has_tenant_access(storage.get_tenant_from_path(name))
);

CREATE POLICY "private_uploads_tenant_update"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'private-uploads'
  AND storage.user_has_tenant_access(storage.get_tenant_from_path(name))
);

CREATE POLICY "private_uploads_tenant_delete"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'private-uploads'
  AND storage.user_has_tenant_access(storage.get_tenant_from_path(name))
);

-- =============================================================================
-- STEP 8: Create service role bypass policies
-- =============================================================================

-- The service role (used by backend APIs) needs full access
-- This is secured by only using service role key server-side
CREATE POLICY "service_role_full_access"
ON storage.objects
FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

-- =============================================================================
-- NOTES FOR IMPLEMENTATION:
-- =============================================================================
-- 
-- 1. Create the buckets in Supabase Dashboard:
--    - public-assets: Public = false, File size limit = 10MB
--    - private-uploads: Public = false, File size limit = 25MB
--
-- 2. File path structure:
--    - {tenant_id}/branding/{filename} - logos, favicons
--    - {tenant_id}/pages/{page_id}/{filename} - page images
--    - {tenant_id}/form-submissions/{form_id}/{submission_id}/{filename} - form uploads
--    - {tenant_id}/attachments/{entity_type}/{entity_id}/{filename} - general attachments
--
-- 3. Backend API must:
--    - Extract tenant_id from session/context
--    - Prepend tenant_id to all storage paths
--    - Use service role for server-side operations
--    - Generate signed URLs for private file access
