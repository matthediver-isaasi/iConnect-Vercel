import { supabase } from '../../../../_lib/database.js';
import { getSession } from '../../../../_lib/session.js';
import crypto from 'crypto';
import { guardSalesLinkedProject } from '../../../../_lib/salesLinkedProjectGuard.js';

const TOKEN_SECRET = process.env.SESSION_SECRET || 'fallback-secret-for-dev-only';

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

  return { card, membership };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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
  const { uploadToken, setAsCover } = req.body || {};

  if (!cardId || !uploadToken) {
    return res.status(400).json({ error: 'Missing required fields: cardId and uploadToken' });
  }

  try {
    const tokenParts = uploadToken.split('.');
    if (tokenParts.length !== 2) {
      return res.status(400).json({ error: 'Invalid upload token format' });
    }

    const [payloadBase64, providedSignature] = tokenParts;
    
    const expectedSignature = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadBase64).digest('base64');
    if (providedSignature !== expectedSignature) {
      return res.status(400).json({ error: 'Invalid upload token signature' });
    }

    let tokenData;
    try {
      tokenData = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
    } catch (e) {
      return res.status(400).json({ error: 'Invalid upload token payload' });
    }

    if (tokenData.cardId !== cardId) {
      return res.status(400).json({ error: 'Token card ID mismatch' });
    }

    if (tokenData.identityId !== session.identityId) {
      return res.status(403).json({ error: 'Token identity mismatch' });
    }

    if (tokenData.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'Upload token expired' });
    }

    const access = await getBoardMembershipForCard(cardId, session.identityId);
    if (!access?.membership) {
      return res.status(403).json({ error: 'Not a member of this board' });
    }

    if (access.membership.role === 'viewer') {
      return res.status(403).json({ error: 'Viewers cannot add attachments' });
    }
    if (!await guardSalesLinkedProject(req, res, access.card.board_id)) return;

    const { storagePath, publicUrl, fileName, fileSize, mimeType } = tokenData;

    if (tokenData.purpose === 'activity') {
      if (!process.env.SESSION_SECRET) {
        return res.status(503).json({ error: 'Activity image signing is not configured' });
      }
      if (!tokenData.attachmentId || tokenData.boardId !== access.card.board_id ||
        !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType) ||
        !Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > 104857600) {
        return res.status(400).json({ error: 'Invalid Activity image upload' });
      }
      const slash = storagePath.lastIndexOf('/');
      const { data: objects, error: objectError } = await supabase.storage.from('file-repository')
        .list(storagePath.slice(0, slash), { search: storagePath.slice(slash + 1), limit: 100 });
      if (objectError) return res.status(503).json({ error: 'Could not verify uploaded image; try again' });
      const object = objects?.find(item => item.name === storagePath.slice(slash + 1));
      if (!object || Number(object.metadata?.size) !== fileSize || object.metadata?.mimetype !== mimeType) {
        return res.status(400).json({ error: 'Uploaded image is missing or does not match its declared type and size' });
      }
      // The signed ID makes confirmation retry-safe after a lost response.
      const { data: attachment, error } = await supabase.from('project_card_attachment')
        .upsert({ id: tokenData.attachmentId, card_id: cardId, name: fileName,
          url: publicUrl, storage_path: storagePath, file_type: mimeType,
          file_size: fileSize, uploaded_by: session.identityId },
        { onConflict: 'id', ignoreDuplicates: true }).select().maybeSingle();
      if (error) return res.status(500).json({ error: 'Failed to save image attachment' });
      if (attachment) return res.json({ attachment });
      const { data: existing, error: readError } = await supabase.from('project_card_attachment')
        .select('*').eq('id', tokenData.attachmentId).eq('card_id', cardId)
        .eq('uploaded_by', session.identityId).single();
      if (readError || !existing) return res.status(500).json({ error: 'Could not confirm image; try again' });
      return res.json({ attachment: existing });
    }

    // Purpose is signed at upload preparation: a caller cannot turn an ordinary
    // attachment upload into a hidden cover by changing the confirmation body.
    if (tokenData.purpose === 'cover') {
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)
        || tokenData.boardId !== access.card.board_id) {
        return res.status(400).json({ error: 'Invalid cover upload' });
      }
      const { data: card, error: coverError } = await supabase
        .from('project_card')
        .update({ cover_image: publicUrl })
        .eq('id', cardId)
        .eq('board_id', tokenData.boardId)
        .select('id, cover_image')
        .single();
      if (coverError || !card) {
        return res.status(500).json({ error: 'Failed to save cover image' });
      }
      const { error: activityError } = await supabase.from('project_card_activity').insert({
        card_id: cardId,
        identity_id: session.identityId,
        action_type: 'cover_set',
        action_data: { fileName }
      });
      if (activityError) console.error('[Attachments] Cover activity error:', activityError.code);
      return res.json({ coverImage: card.cover_image });
    }

    const { data: attachment, error: insertError } = await supabase
      .from('project_card_attachment')
      .insert({
        card_id: cardId,
        name: fileName,
        url: publicUrl,
        storage_path: storagePath,
        file_type: mimeType,
        file_size: fileSize,
        uploaded_by: session.identityId
      })
      .select()
      .single();

    if (insertError) {
      console.error('[Attachments] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to save attachment record' });
    }

    if (setAsCover && mimeType?.startsWith('image/')) {
      await supabase
        .from('project_card')
        .update({ cover_image: publicUrl })
        .eq('id', cardId);
    }

    await supabase.from('project_card_activity').insert({
      card_id: cardId,
      identity_id: session.identityId,
      action_type: 'attachment_added',
      action_data: { fileName, fileSize, attachmentId: attachment.id }
    });

    return res.json({ attachment });
  } catch (err) {
    console.error('[Attachments] Confirm error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
