import { supabase } from '../_lib/database.js';

const STORAGE_BUCKET = 'file-repository';

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
        let isPrivate = false;
        
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
            } else if (fieldName === 'private') {
              isPrivate = content.toString().trim() === 'true';
            }
          }
        }
        
        resolve({ file, isPrivate });
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
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
    const { file, isPrivate } = await parseMultipartForm(req);
    
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    const sanitizedName = sanitizeFileName(file.originalname);
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const storagePath = `uploads/${uniqueId}-${sanitizedName}`;
    
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false
      });
    
    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: 'Failed to upload file: ' + error.message });
    }
    
    const { data: publicUrlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);
    
    return res.json({ 
      file_url: publicUrlData.publicUrl,
      file_name: file.originalname,
      file_size: file.size,
      mime_type: file.mimetype
    });
  } catch (error) {
    console.error('File upload error:', error);
    return res.status(500).json({ error: 'Upload failed: ' + (error.message || 'Unknown error') });
  }
}
