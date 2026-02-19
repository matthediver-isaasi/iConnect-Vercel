import { getTenantContext } from '../_lib/tenantContext.js';
import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: false,
  },
};

function sanitizeFileName(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

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

        for (const part of parts) {
          if (part.length < 4) continue;

          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;

          const headers = part.slice(0, headerEnd).toString();
          const content = part.slice(headerEnd + 4);

          const nameMatch = headers.match(/name="([^"]+)"/);
          const filenameMatch = headers.match(/filename="([^"]+)"/);
          const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

          if (nameMatch && filenameMatch && nameMatch[1] === 'file') {
            file = {
              originalname: filenameMatch[1],
              mimetype: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
              buffer: content.slice(0, content.length - 2),
              size: content.length - 2
            };
          }
        }

        resolve({ file });
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Storage not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { file } = await parseMultipartForm(req);

    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' });
    }

    if (file.size > MAX_SIZE) {
      return res.status(400).json({ error: 'File size exceeds 5MB limit' });
    }

    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const sanitizedName = sanitizeFileName(file.originalname);
    const storagePath = `${tenantContext.tenantId}/fundraising/updates/${uniqueId}-${sanitizedName}`;

    const { error } = await supabase.storage
      .from('public-assets')
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
      console.error('[Admin Upload Update Image] Upload error:', error);
      return res.status(500).json({ error: 'Failed to upload image' });
    }

    const { data: publicUrlData } = supabase.storage
      .from('public-assets')
      .getPublicUrl(storagePath);

    return res.json({ url: publicUrlData.publicUrl });
  } catch (err) {
    console.error('[Admin Upload Update Image] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
