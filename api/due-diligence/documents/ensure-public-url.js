import { supabase } from '../../_lib/database.js';
import { getSessionMember } from '../../_lib/session.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

const PUBLIC_BUCKET = 'public-assets';
const PRIVATE_BUCKET = 'private-uploads';
const ALLOWED_SOURCE_BUCKETS = new Set([PUBLIC_BUCKET, PRIVATE_BUCKET]);

/**
 * Parse bucket + storage path from a stored file_url.
 * Supports:
 *   - /api/storage/secure-url?bucket=...&path=... (proxy URL for private files)
 *   - https://<project>.supabase.co/storage/v1/object/(public|sign|authenticated)/<bucket>/<path>
 */
function parseStorageRef(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') return null;

  if (fileUrl.startsWith('/api/storage/secure-url')) {
    try {
      const qs = fileUrl.split('?')[1];
      if (!qs) return null;
      const params = new URLSearchParams(qs);
      const bucket = params.get('bucket');
      const path = params.get('path') || params.get('storagePath');
      if (!bucket || !path) return null;
      return { bucket, path: decodeURIComponent(path) };
    } catch {
      return null;
    }
  }

  if (fileUrl.startsWith('http')) {
    try {
      const u = new URL(fileUrl);
      const m = u.pathname.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
      if (m) {
        return {
          bucket: decodeURIComponent(m[1]),
          path: decodeURIComponent(m[2])
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

function buildPublicPathFromPrivate(privatePath, fileName) {
  // Private upload paths are typically `${tenantId}/documents/${entityId}/<unique>-<name>`
  // Mirror the same convention; if path doesn't already include a tenant prefix,
  // caller must supply tenantId guarantee (we always do).
  const trailing = privatePath.split('/').pop() || fileName || `file-${Date.now()}`;
  const segments = privatePath.split('/');
  const tenantSeg = segments[0];
  // Place under <tenantId>/documents/published/<unique-trailing> to keep tenant scoping
  // and mark it as the published mirror of a private upload.
  return `${tenantSeg}/documents/published/${Date.now()}-${trailing}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  try {
    const { documentId } = req.body || {};

    if (!documentId) {
      return res.status(400).json({ error: 'documentId is required' });
    }

    const { data: doc, error: fetchError } = await supabase
      .from('submission_document')
      .select('*')
      .eq('id', documentId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (fetchError || !doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (doc.status !== 'approved') {
      return res.status(400).json({
        error: 'Document is not approved',
        message: 'A public URL can only be generated for an approved version.'
      });
    }

    // Idempotent: already published
    if (doc.public_file_url) {
      return res.status(200).json({
        success: true,
        publicUrl: doc.public_file_url,
        publicPath: doc.public_storage_path || null,
        document: doc,
        alreadyPublic: true
      });
    }

    const ref = parseStorageRef(doc.file_url);
    if (!ref) {
      return res.status(400).json({
        error: 'Cannot derive storage location from file_url',
        message: 'This document\'s file_url is not a recognised Supabase storage reference.'
      });
    }

    if (!ALLOWED_SOURCE_BUCKETS.has(ref.bucket)) {
      return res.status(400).json({
        error: 'Unsupported source bucket',
        message: `Source bucket "${ref.bucket}" is not allowed. Expected one of: ${[...ALLOWED_SOURCE_BUCKETS].join(', ')}.`
      });
    }

    // Verify tenant scoping on the path itself (defence in depth)
    const pathTenant = (ref.path.split('/')[0] || '').toLowerCase();
    if (pathTenant && pathTenant !== tenantCtx.tenantId.toLowerCase()) {
      return res.status(403).json({ error: 'Access denied to this file' });
    }

    let finalBucket;
    let finalPath;

    if (ref.bucket === PUBLIC_BUCKET) {
      // Already in public bucket – just compute the URL.
      finalBucket = PUBLIC_BUCKET;
      finalPath = ref.path;
    } else {
      // Need to copy from private-uploads to public-assets.
      const sourceBucket = ref.bucket;
      const sourcePath = ref.path;

      const { data: fileData, error: downloadError } = await supabase.storage
        .from(sourceBucket)
        .download(sourcePath);

      if (downloadError || !fileData) {
        console.error('[DD ensure-public-url] Download failed:', downloadError);
        return res.status(404).json({
          error: 'Source file not found',
          message: downloadError?.message || 'Unable to read the original file from storage.'
        });
      }

      const targetPath = buildPublicPathFromPrivate(sourcePath, doc.file_name);
      const contentType = doc.mime_type || fileData.type || 'application/octet-stream';

      const arrayBuf = await fileData.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      const { error: uploadError } = await supabase.storage
        .from(PUBLIC_BUCKET)
        .upload(targetPath, buf, {
          contentType,
          upsert: true
        });

      if (uploadError) {
        console.error('[DD ensure-public-url] Upload to public bucket failed:', uploadError);
        return res.status(500).json({
          error: 'Failed to publish file',
          message: uploadError.message || 'Could not copy file to public bucket.'
        });
      }

      finalBucket = PUBLIC_BUCKET;
      finalPath = targetPath;
    }

    const { data: publicData } = supabase.storage
      .from(finalBucket)
      .getPublicUrl(finalPath);

    const publicUrl = publicData?.publicUrl;
    if (!publicUrl) {
      return res.status(500).json({ error: 'Failed to compute public URL' });
    }

    const { data: updatedDoc, error: updateError } = await supabase
      .from('submission_document')
      .update({
        public_file_url: publicUrl,
        public_storage_path: finalPath,
        updated_at: new Date().toISOString()
      })
      .eq('id', documentId)
      .eq('tenant_id', tenantCtx.tenantId)
      .select()
      .single();

    if (updateError) {
      console.error('[DD ensure-public-url] Persist failed:', updateError);
      return res.status(500).json({ error: 'Failed to save public URL on document' });
    }

    return res.status(200).json({
      success: true,
      publicUrl,
      publicPath: finalPath,
      document: updatedDoc,
      alreadyPublic: false
    });
  } catch (error) {
    console.error('[DD ensure-public-url] Error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + (error.message || 'Unknown error') });
  }
}
