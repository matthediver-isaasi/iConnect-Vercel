import { supabase } from '../../../../_lib/database.js';
import { getSession } from '../../../../_lib/session.js';

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
  const { storagePath, publicUrl, fileName, fileSize, mimeType, setAsCover } = req.body;

  if (!cardId || !storagePath || !publicUrl || !fileName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const access = await getBoardMembershipForCard(cardId, session.identityId);
    if (!access?.membership) {
      return res.status(403).json({ error: 'Not a member of this board' });
    }

    if (access.membership.role === 'viewer') {
      return res.status(403).json({ error: 'Viewers cannot add attachments' });
    }

    const { data: attachment, error: insertError } = await supabase
      .from('project_card_attachment')
      .insert({
        card_id: cardId,
        name: fileName,
        url: publicUrl,
        storage_path: storagePath,
        file_type: mimeType || 'application/octet-stream',
        file_size: fileSize || 0,
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
