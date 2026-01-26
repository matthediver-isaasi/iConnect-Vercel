/**
 * Secure URL API - Generate signed URLs for private file access
 * 
 * This endpoint validates that the requesting user belongs to the same tenant
 * as the file owner before generating a signed URL for download.
 * 
 * Files are stored with tenant-prefixed paths: {tenant_id}/...
 * This allows us to verify access by checking if the requesting user's
 * tenant matches the tenant in the file path.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

const BUCKETS = {
  PUBLIC: 'public-assets',
  PRIVATE: 'private-uploads'
};

// Signed URL validity duration (in seconds)
const SIGNED_URL_EXPIRY = 3600; // 1 hour

/**
 * Extract tenant ID from storage path
 * Path format: {tenant_uuid}/...
 */
function extractTenantFromPath(storagePath) {
  if (!storagePath) return null;
  
  const parts = storagePath.split('/');
  if (parts.length < 1) return null;
  
  const potentialUuid = parts[0];
  
  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(potentialUuid)) {
    return potentialUuid;
  }
  
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Storage service not configured' });
  }

  try {
    // Get tenant context - REQUIRED for private file access
    const tenantContext = await getTenantContext(req);
    
    if (!tenantContext.isAuthenticated || !tenantContext.tenantId) {
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'You must be logged in to access private files'
      });
    }

    const userTenantId = tenantContext.tenantId;

    // Get request parameters
    const { bucket, path: storagePath, download } = req.query;

    if (!storagePath) {
      return res.status(400).json({ error: 'Storage path is required' });
    }

    // Default to private bucket if not specified
    const targetBucket = bucket || BUCKETS.PRIVATE;

    // Validate bucket name
    if (!Object.values(BUCKETS).includes(targetBucket)) {
      return res.status(400).json({ error: 'Invalid bucket specified' });
    }

    // Extract tenant from file path
    const fileTenantId = extractTenantFromPath(storagePath);

    if (!fileTenantId) {
      console.error('[SecureUrl] Invalid storage path format:', storagePath);
      return res.status(400).json({ 
        error: 'Invalid file path',
        message: 'File path does not include valid tenant identifier'
      });
    }

    // CRITICAL: Verify user belongs to the same tenant as the file
    if (fileTenantId.toLowerCase() !== userTenantId.toLowerCase()) {
      console.warn('[SecureUrl] Tenant mismatch - access denied:', {
        userTenant: userTenantId,
        fileTenant: fileTenantId,
        path: storagePath
      });
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'You do not have permission to access this file'
      });
    }

    console.log('[SecureUrl] Generating signed URL:', {
      tenantId: userTenantId,
      bucket: targetBucket,
      path: storagePath.substring(0, 50) + '...'
    });

    // Get request parameters
    const { redirect } = req.query;

    // Generate signed URL
    const options = {
      download: download === 'true' ? true : undefined
    };

    const { data, error } = await supabase.storage
      .from(targetBucket)
      .createSignedUrl(storagePath, SIGNED_URL_EXPIRY, options);

    if (error) {
      console.error('[SecureUrl] Failed to generate signed URL:', error);
      
      // Check if file doesn't exist
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        return res.status(404).json({ 
          error: 'File not found',
          message: 'The requested file does not exist'
        });
      }
      
      return res.status(500).json({ error: 'Failed to generate access URL: ' + error.message });
    }

    // If redirect=true, redirect to the signed URL (useful for iframe embedding)
    if (redirect === 'true') {
      return res.redirect(302, data.signedUrl);
    }

    return res.json({
      success: true,
      signedUrl: data.signedUrl,
      expiresIn: SIGNED_URL_EXPIRY,
      bucket: targetBucket,
      path: storagePath
    });

  } catch (error) {
    console.error('[SecureUrl] Error generating signed URL:', error);
    return res.status(500).json({ error: 'Failed to generate access URL: ' + (error.message || 'Unknown error') });
  }
}
