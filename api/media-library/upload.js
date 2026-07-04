import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase as dbSupabase } from '../_lib/database.js';
import { createClient } from '@supabase/supabase-js';
import { checkStorageQuota } from '../_lib/planQuota.js';
import { addTenantStorageBytes } from '../_lib/tenantStorageUsage.js';

export const config = { api: { bodyParser: false } };

function sanitizeFileName(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const contentType = req.headers['content-type'] || '';
    const m = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    if (!m) return reject(new Error('No multipart boundary'));
    const boundary = m[1] || m[2];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const bnd = Buffer.from(`--${boundary}`);
        const parts = [];
        let start = 0;
        while (true) {
          const idx = buf.indexOf(bnd, start);
          if (idx === -1) break;
          if (start > 0) parts.push(buf.slice(start, idx - 2));
          start = idx + bnd.length + 2;
        }
        let file = null;
        const fields = {};
        for (const part of parts) {
          if (part.length < 4) continue;
          const he = part.indexOf('\r\n\r\n');
          if (he === -1) continue;
          const headers = part.slice(0, he).toString();
          const content = part.slice(he + 4, part.length - 2);
          const nameM = headers.match(/name="([^"]+)"/);
          const fileM = headers.match(/filename="([^"]+)"/);
          const ctM = headers.match(/Content-Type:\s*([^\r\n]+)/i);
          if (!nameM) continue;
          if (fileM) {
            if (nameM[1] === 'file') {
              file = {
                originalname: fileM[1],
                mimetype: ctM ? ctM[1].trim() : 'application/octet-stream',
                buffer: content,
                size: content.length,
              };
            }
          } else {
            fields[nameM[1]] = content.toString();
          }
        }
        resolve({ file, fields });
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Phase 7 — Media library accepts image and video assets so that
// image/hero/card blocks (images) and video blocks (mp4/webm) can both
// reuse the same library. Documents (PDF/Office/text) are also accepted so
// that link and button targets in CanvasBuilder can point to downloadable
// files. Type is derived from MIME on read.
const ALLOWED_IMAGE = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
const ALLOWED_VIDEO = ['video/mp4', 'video/webm', 'video/ogg'];
const ALLOWED_DOCUMENT = [
  'application/pdf',
  'application/msword', // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.ms-excel', // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-powerpoint', // .ppt
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'text/plain', // .txt
  'text/csv', // .csv
  'application/rtf', 'text/rtf', // .rtf
  'application/vnd.oasis.opendocument.text', // .odt
];
const ALLOWED = [...ALLOWED_IMAGE, ...ALLOWED_VIDEO, ...ALLOWED_DOCUMENT];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const MAX_DOCUMENT_SIZE = 25 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(503).json({ error: 'Storage not configured' });

  let context;
  try { context = await getTenantContext(req); }
  catch { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });

  const storage = createClient(supabaseUrl, serviceKey);
  let parsed;
  try { parsed = await parseMultipart(req); }
  catch { return res.status(400).json({ error: 'Invalid multipart body' }); }
  const file = parsed.file;
  if (!file) return res.status(400).json({ error: 'No file provided' });
  if (!ALLOWED.includes(file.mimetype)) return res.status(400).json({ error: 'Unsupported file type (images, video, and documents only)' });
  const isVideo = ALLOWED_VIDEO.includes(file.mimetype);
  const isDocument = ALLOWED_DOCUMENT.includes(file.mimetype);
  const cap = isVideo ? MAX_VIDEO_SIZE : isDocument ? MAX_DOCUMENT_SIZE : MAX_IMAGE_SIZE;
  const capLabel = isVideo ? '100MB' : isDocument ? '25MB' : '10MB';
  if (file.size > cap) return res.status(400).json({ error: `File too large (max ${capLabel})` });

  const storageCheck = await checkStorageQuota(context.tenantId, { fileSizeBytes: file.size });
  if (!storageCheck.ok) return res.status(storageCheck.status).json(storageCheck.body);

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const path = `${context.tenantId}/canvas-media/${id}-${sanitizeFileName(file.originalname)}`;
  const up = await storage.storage.from('public-assets').upload(path, file.buffer, {
    contentType: file.mimetype, cacheControl: '3600', upsert: false,
  });
  if (up.error) return res.status(500).json({ error: 'Upload failed' });
  addTenantStorageBytes(context.tenantId, file.size).catch(() => {});
  const { data: pub } = storage.storage.from('public-assets').getPublicUrl(path);
  const url = pub?.publicUrl;

  // Register the asset so it shows in the library immediately.
  const altText = parsed.fields?.alt_text || null;
  const name = parsed.fields?.name || file.originalname;
  if (dbSupabase) {
    const { data, error } = await dbSupabase.from('media_asset').insert({
      tenant_id: context.tenantId,
      name: String(name).slice(0, 255),
      url,
      alt_text: altText,
      mime_type: file.mimetype,
      byte_size: file.size,
      uploaded_by: context.memberId || null,
    }).select().single();
    if (!error && data) return res.status(201).json({ asset: data });
  }
  return res.status(201).json({ asset: { url, name } });
}
