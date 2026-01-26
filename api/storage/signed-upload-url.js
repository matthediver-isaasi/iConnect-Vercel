/**
 * Tenant-Scoped Signed Upload URL API
 * 
 * This endpoint generates pre-signed upload URLs for large file uploads
 * directly to Supabase Storage. It enforces tenant isolation by prefixing
 * all storage paths with the tenant ID.
 * 
 * For authenticated users: tenant is determined from session
 * For public form submissions: tenant is looked up from the form record
 * 
 * This is the secure replacement for /api/integrations/signed-upload-url
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

/**
 * Look up tenant from form record for public form submissions
 */
async function getTenantFromForm(formId) {
  if (!formId) return null;
  
  try {
    const { data: form, error } = await supabase
      .from('form')
      .select('tenant_id')
      .eq('id', formId)
      .single();
    
    if (error || !form) {
      console.log('[SignedUpload] Form lookup failed:', error?.message || 'Form not found');
      return null;
    }
    
    return form.tenant_id;
  } catch (err) {
    console.error('[SignedUpload] Error looking up form tenant:', err);
    return null;
  }
}

const BUCKETS = {
  PUBLIC: 'public-assets',
  PRIVATE: 'private-uploads'
};

const MAX_FILE_SIZE = {
  [BUCKETS.PUBLIC]: 10 * 1024 * 1024, // 10MB for public assets
  [BUCKETS.PRIVATE]: 25 * 1024 * 1024 // 25MB for private uploads
};

function sanitizeFileName(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

/**
 * Determine which bucket to use based on upload type
 */
function getBucketForType(uploadType) {
  const privateTypes = ['form-submission', 'attachment', 'document', 'private'];
  if (privateTypes.includes(uploadType)) {
    return BUCKETS.PRIVATE;
  }
  return BUCKETS.PUBLIC;
}

/**
 * Build the storage path with tenant scoping
 */
function buildStoragePath(tenantId, uploadType, entityId, fileName) {
  const sanitizedName = sanitizeFileName(fileName);
  const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  
  switch (uploadType) {
    case 'branding':
      return `${tenantId}/branding/${uniqueId}-${sanitizedName}`;
    case 'page':
      return `${tenantId}/pages/${entityId || 'general'}/${uniqueId}-${sanitizedName}`;
    case 'form-submission':
      return `${tenantId}/form-submissions/${entityId || 'general'}/${uniqueId}-${sanitizedName}`;
    case 'attachment':
      return `${tenantId}/attachments/${entityId || 'general'}/${uniqueId}-${sanitizedName}`;
    case 'document':
      return `${tenantId}/documents/${entityId || 'general'}/${uniqueId}-${sanitizedName}`;
    default:
      return `${tenantId}/uploads/${uniqueId}-${sanitizedName}`;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Storage service not configured' });
  }

  try {
    // Get request body first to check upload type
    const { fileName, fileSize, mimeType, type: uploadType, entityId, isPrivate, formId } = req.body;

    // Get tenant context
    const tenantContext = await getTenantContext(req);
    
    let tenantId = tenantContext.tenantId;
    
    // For public form submissions, allow unauthenticated uploads
    // but still require a valid form to determine tenant
    if (!tenantContext.isAuthenticated || !tenantId) {
      if (uploadType === 'form-submission' && formId) {
        // Look up tenant from the form record
        tenantId = await getTenantFromForm(formId);
        
        if (!tenantId) {
          return res.status(400).json({ 
            error: 'Invalid form',
            message: 'Could not determine tenant for this form submission'
          });
        }
        
        console.log('[SignedUpload] Public form submission - tenant from form:', tenantId);
      } else {
        // Non-form uploads require authentication
        return res.status(401).json({ 
          error: 'Authentication required',
          message: 'You must be logged in to upload files'
        });
      }
    }

    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    if (!fileSize || typeof fileSize !== 'number') {
      return res.status(400).json({ error: 'fileSize is required and must be a number' });
    }

    // Determine bucket based on upload type
    const usePrivate = isPrivate || getBucketForType(uploadType || 'upload') === BUCKETS.PRIVATE;
    const bucket = usePrivate ? BUCKETS.PRIVATE : BUCKETS.PUBLIC;

    // Check file size
    const maxSize = MAX_FILE_SIZE[bucket];
    if (fileSize > maxSize) {
      return res.status(400).json({ 
        error: `File size exceeds maximum allowed size of ${maxSize / (1024 * 1024)}MB`,
        maxSize,
        providedSize: fileSize
      });
    }

    // Build tenant-scoped storage path
    const storagePath = buildStoragePath(tenantId, uploadType || 'upload', entityId, fileName);

    console.log('[SignedUpload] Generating signed upload URL:', {
      tenantId,
      bucket,
      path: storagePath,
      type: uploadType,
      size: fileSize
    });

    // Create signed upload URL
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUploadUrl(storagePath);

    if (error) {
      console.error('[SignedUpload] Supabase signed URL error:', error);
      return res.status(500).json({ error: 'Failed to generate upload URL: ' + error.message });
    }

    // Determine the final URL format
    let finalUrl;
    if (bucket === BUCKETS.PUBLIC) {
      const { data: publicUrlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(storagePath);
      finalUrl = publicUrlData.publicUrl;
    } else {
      // Private files use secure URL endpoint with redirect for iframe embedding
      finalUrl = `/api/storage/secure-url?bucket=${bucket}&path=${encodeURIComponent(storagePath)}&redirect=true`;
    }

    return res.json({
      success: true,
      signedUrl: data.signedUrl,
      token: data.token,
      path: storagePath,
      bucket: bucket,
      fileUrl: finalUrl,
      isPrivate: usePrivate,
      tenantId: tenantId,
      expiresIn: 3600 // 1 hour
    });

  } catch (error) {
    console.error('[SignedUpload] Error generating signed upload URL:', error);
    return res.status(500).json({ error: 'Failed to generate upload URL: ' + (error.message || 'Unknown error') });
  }
}
