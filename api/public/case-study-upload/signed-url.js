import { supabase } from '../../_lib/database.js';

const PRIVATE_BUCKET = 'private-uploads';
const MAX_FILE_SIZE = 25 * 1024 * 1024;

function sanitizeFileName(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
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
    return res.status(503).json({ error: 'Service unavailable' });
  }

  try {
    const { token, fileName, fileSize, mimeType } = req.body || {};

    const cleanToken = (token || '').toString().trim();
    if (!cleanToken || cleanToken.length < 32 || cleanToken.length > 256) {
      return res.status(404).json({ error: 'This link is no longer valid' });
    }
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }
    if (typeof fileSize !== 'number' || fileSize <= 0) {
      return res.status(400).json({ error: 'fileSize is required and must be a positive number' });
    }
    if (fileSize > MAX_FILE_SIZE) {
      return res.status(400).json({
        error: `File size exceeds maximum allowed size of ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
        maxSize: MAX_FILE_SIZE,
      });
    }

    const { data: brief, error: briefError } = await supabase
      .from('article_brief')
      .select('id, tenant_id, case_study_upload_token')
      .eq('case_study_upload_token', cleanToken)
      .maybeSingle();

    if (briefError) {
      console.error('[CaseStudyUpload SignedUrl] Brief lookup error:', briefError);
      return res.status(500).json({ error: 'Failed to generate upload URL' });
    }
    if (!brief || brief.case_study_upload_token !== cleanToken) {
      return res.status(404).json({ error: 'This link is no longer valid' });
    }

    const sanitized = sanitizeFileName(fileName);
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const storagePath = `${brief.tenant_id}/article-briefs/${brief.id}/case-study-uploads/${uniqueId}-${sanitized}`;

    const { data, error } = await supabase.storage
      .from(PRIVATE_BUCKET)
      .createSignedUploadUrl(storagePath);

    if (error) {
      console.error('[CaseStudyUpload SignedUrl] Supabase signed URL error:', error);
      return res.status(500).json({ error: 'Failed to generate upload URL' });
    }

    const fileUrl = `/api/storage/secure-url?bucket=${PRIVATE_BUCKET}&path=${encodeURIComponent(storagePath)}&redirect=true`;

    return res.json({
      success: true,
      signedUrl: data.signedUrl,
      token: data.token,
      path: storagePath,
      bucket: PRIVATE_BUCKET,
      fileUrl,
      expiresIn: 3600,
    });
  } catch (err) {
    console.error('[CaseStudyUpload SignedUrl] Error:', err);
    return res.status(500).json({ error: 'Failed to generate upload URL' });
  }
}
