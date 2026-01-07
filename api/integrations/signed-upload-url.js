import { supabase } from '../_lib/database.js';

const STORAGE_BUCKET = 'file-repository';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB in bytes

function sanitizeFileName(name) {
  return name
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
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const { fileName, fileSize, mimeType } = req.body;

    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    if (!fileSize || typeof fileSize !== 'number') {
      return res.status(400).json({ error: 'fileSize is required and must be a number' });
    }

    if (fileSize > MAX_FILE_SIZE) {
      return res.status(400).json({ 
        error: `File size exceeds maximum allowed size of 25MB`,
        maxSize: MAX_FILE_SIZE,
        providedSize: fileSize
      });
    }

    const sanitizedName = sanitizeFileName(fileName);
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const storagePath = `uploads/${uniqueId}-${sanitizedName}`;

    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUploadUrl(storagePath);

    if (error) {
      console.error('Supabase signed URL error:', error);
      return res.status(500).json({ error: 'Failed to generate upload URL: ' + error.message });
    }

    const { data: publicUrlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    return res.json({
      signedUrl: data.signedUrl,
      token: data.token,
      path: storagePath,
      publicUrl: publicUrlData.publicUrl,
      expiresIn: 3600
    });
  } catch (error) {
    console.error('Signed URL generation error:', error);
    return res.status(500).json({ error: 'Failed to generate upload URL: ' + (error.message || 'Unknown error') });
  }
}
