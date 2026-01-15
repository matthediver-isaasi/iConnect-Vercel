import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';

const STORAGE_BUCKET = 'file-repository';
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'application/json', 'application/zip', 'application/x-rar-compressed'
];

function sanitizeFileName(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

async function getBoardMembershipForCard(cardId, identityId) {
  const { data: card } = await supabase
    .from('project_card')
    .select('board_id, list_id, title')
    .eq('id', cardId)
    .single();

  if (!card) return null;

  const { data: membership } = await supabase
    .from('project_board_member')
    .select('role')
    .eq('board_id', card.board_id)
    .eq('identity_id', identityId)
    .single();

  const { data: board } = await supabase
    .from('project_board')
    .select('tenant_id')
    .eq('id', card.board_id)
    .single();

  return { card, membership, board };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionResult = await getSession(req);
  if (!sessionResult?.data) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = sessionResult.data;
  const { cardId } = req.query;

  if (!cardId) {
    return res.status(400).json({ error: 'Card ID required' });
  }

  try {
    const access = await getBoardMembershipForCard(cardId, session.identityId);
    if (!access?.membership) {
      return res.status(403).json({ error: 'Not a member of this board' });
    }

    if (req.method === 'GET') {
      const { data: attachments, error } = await supabase
        .from('project_card_attachment')
        .select('*')
        .eq('card_id', cardId)
        .order('uploaded_at', { ascending: false });

      if (error) {
        console.error('[Attachments] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch attachments' });
      }

      return res.json({ attachments: attachments || [] });
    }

    if (req.method === 'POST') {
      if (access.membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot upload attachments' });
      }

      const { fileName, fileSize, mimeType } = req.body;

      if (!fileName) {
        return res.status(400).json({ error: 'fileName is required' });
      }

      if (!fileSize || typeof fileSize !== 'number') {
        return res.status(400).json({ error: 'fileSize is required and must be a number' });
      }

      if (fileSize > MAX_FILE_SIZE) {
        return res.status(400).json({ 
          error: 'File size exceeds maximum allowed size of 100MB',
          maxSize: MAX_FILE_SIZE,
          providedSize: fileSize
        });
      }

      if (mimeType && !ALLOWED_TYPES.includes(mimeType)) {
        return res.status(400).json({ 
          error: 'File type not allowed',
          allowedTypes: ALLOWED_TYPES
        });
      }

      const sanitizedName = sanitizeFileName(fileName);
      const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const storagePath = `project-attachments/${access.board.tenant_id}/${access.card.board_id}/${cardId}/${uniqueId}-${sanitizedName}`;

      const { data: signedData, error: signedError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUploadUrl(storagePath);

      if (signedError) {
        console.error('[Attachments] Signed URL error:', signedError);
        return res.status(500).json({ error: 'Failed to generate upload URL: ' + signedError.message });
      }

      const { data: publicUrlData } = supabase.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(storagePath);

      return res.json({
        signedUrl: signedData.signedUrl,
        token: signedData.token,
        storagePath,
        publicUrl: publicUrlData.publicUrl,
        cardId,
        fileName: sanitizedName,
        originalName: fileName,
        fileSize,
        mimeType: mimeType || 'application/octet-stream',
        expiresIn: 3600
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Attachments] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
