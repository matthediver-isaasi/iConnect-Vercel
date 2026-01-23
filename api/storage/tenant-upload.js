/**
 * Tenant-Scoped File Upload API
 * 
 * This endpoint handles file uploads with proper tenant isolation.
 * Files are stored in tenant-prefixed paths to ensure complete data separation.
 * 
 * Supported buckets:
 * - public-assets: For branding, logos, public page images (publicly readable)
 * - private-uploads: For form submissions, sensitive documents (authenticated access only)
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

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

export const config = {
  api: {
    bodyParser: false,
  },
};

async function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    let body = [];
    let boundary = null;
    
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    if (boundaryMatch) {
      boundary = boundaryMatch[1] || boundaryMatch[2];
    }
    
    if (!boundary) {
      return reject(new Error('No boundary found in content-type'));
    }
    
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(body);
        const boundaryBuffer = Buffer.from(`--${boundary}`);
        const parts = [];
        let start = 0;
        
        while (true) {
          const idx = buffer.indexOf(boundaryBuffer, start);
          if (idx === -1) break;
          if (start > 0) {
            parts.push(buffer.slice(start, idx - 2));
          }
          start = idx + boundaryBuffer.length + 2;
        }
        
        let file = null;
        const fields = {};
        
        for (const part of parts) {
          if (part.length < 4) continue;
          
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          
          const headers = part.slice(0, headerEnd).toString();
          const content = part.slice(headerEnd + 4);
          
          const nameMatch = headers.match(/name="([^"]+)"/);
          const filenameMatch = headers.match(/filename="([^"]+)"/);
          const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
          
          if (nameMatch) {
            const fieldName = nameMatch[1];
            
            if (filenameMatch && fieldName === 'file') {
              file = {
                originalname: filenameMatch[1],
                mimetype: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
                buffer: content.slice(0, content.length - 2),
                size: content.length - 2
              };
            } else {
              // Regular form field
              fields[fieldName] = content.toString().trim();
            }
          }
        }
        
        resolve({ file, fields });
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
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
    // Get tenant context - REQUIRED for all uploads
    const tenantContext = await getTenantContext(req);
    
    if (!tenantContext.tenantId) {
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'You must be logged in to upload files'
      });
    }

    const tenantId = tenantContext.tenantId;

    // Parse multipart form data
    const { file, fields } = await parseMultipartForm(req);
    
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Get upload parameters
    const uploadType = fields.type || 'upload'; // branding, page, form-submission, attachment, document
    const entityId = fields.entityId || null;
    const isPrivate = fields.private === 'true' || getBucketForType(uploadType) === BUCKETS.PRIVATE;

    // Select bucket based on upload type
    const bucket = isPrivate ? BUCKETS.PRIVATE : BUCKETS.PUBLIC;

    // Check file size
    const maxSize = MAX_FILE_SIZE[bucket];
    if (file.size > maxSize) {
      return res.status(400).json({ 
        error: `File size exceeds maximum allowed size of ${maxSize / (1024 * 1024)}MB`,
        maxSize,
        providedSize: file.size
      });
    }

    // Build tenant-scoped storage path
    const storagePath = buildStoragePath(tenantId, uploadType, entityId, file.originalname);

    console.log('[TenantUpload] Uploading file:', {
      tenantId,
      bucket,
      path: storagePath,
      type: uploadType,
      size: file.size
    });

    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false
      });
    
    if (error) {
      console.error('[TenantUpload] Supabase upload error:', error);
      return res.status(500).json({ error: 'Failed to upload file: ' + error.message });
    }

    // Generate URL based on bucket type
    let fileUrl;
    if (bucket === BUCKETS.PUBLIC) {
      // Public assets get a direct public URL
      const { data: publicUrlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(storagePath);
      fileUrl = publicUrlData.publicUrl;
    } else {
      // Private uploads get a reference path - actual URL must be fetched via secure endpoint
      // We return a secure reference that can be used to request a signed URL
      fileUrl = `/api/storage/secure-url?bucket=${bucket}&path=${encodeURIComponent(storagePath)}`;
    }

    return res.json({ 
      success: true,
      file_url: fileUrl,
      storage_path: storagePath,
      bucket: bucket,
      file_name: file.originalname,
      file_size: file.size,
      mime_type: file.mimetype,
      is_private: isPrivate,
      tenant_id: tenantId
    });

  } catch (error) {
    console.error('[TenantUpload] File upload error:', error);
    return res.status(500).json({ error: 'Upload failed: ' + (error.message || 'Unknown error') });
  }
}
