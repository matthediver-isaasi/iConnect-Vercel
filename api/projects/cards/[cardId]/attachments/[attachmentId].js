import { supabase } from '../../../../_lib/database.js';
import { getSession } from '../../../../_lib/session.js';

const STORAGE_BUCKET = 'file-repository';

async function getBoardMembershipForCard(cardId, identityId) {
  const { data: card } = await supabase
    .from('project_card')
    .select('board_id, list_id, title, cover_image')
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, PATCH, OPTIONS');
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
  const { cardId, attachmentId } = req.query;

  if (!cardId || !attachmentId) {
    return res.status(400).json({ error: 'Card ID and Attachment ID required' });
  }

  try {
    const access = await getBoardMembershipForCard(cardId, session.identityId);
    if (!access?.membership) {
      return res.status(403).json({ error: 'Not a member of this board' });
    }

    const { data: attachment } = await supabase
      .from('project_card_attachment')
      .select('*')
      .eq('id', attachmentId)
      .eq('card_id', cardId)
      .single();

    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    if (req.method === 'GET') {
      if (attachment.storage_path) {
        const { data: signedData, error: signedError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .createSignedUrl(attachment.storage_path, 3600);

        if (!signedError && signedData) {
          return res.json({ 
            attachment,
            downloadUrl: signedData.signedUrl,
            expiresIn: 3600
          });
        }
      }
      
      return res.json({ attachment, downloadUrl: attachment.url });
    }

    if (req.method === 'PATCH') {
      if (access.membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot modify attachments' });
      }

      const { setAsCover, clearCover } = req.body;

      if (setAsCover && attachment.file_type?.startsWith('image/')) {
        await supabase
          .from('project_card')
          .update({ cover_image: attachment.url })
          .eq('id', cardId);

        await supabase.from('project_card_activity').insert({
          card_id: cardId,
          identity_id: session.identityId,
          action_type: 'cover_set',
          action_data: { attachmentId, fileName: attachment.name }
        });

        return res.json({ success: true, coverImage: attachment.url });
      }

      if (clearCover) {
        await supabase
          .from('project_card')
          .update({ cover_image: null })
          .eq('id', cardId);

        await supabase.from('project_card_activity').insert({
          card_id: cardId,
          identity_id: session.identityId,
          action_type: 'cover_cleared',
          action_data: {}
        });

        return res.json({ success: true, coverImage: null });
      }

      return res.status(400).json({ error: 'No valid update operation specified' });
    }

    if (req.method === 'DELETE') {
      const canDelete = ['owner', 'admin'].includes(access.membership.role) || 
                        attachment.uploaded_by === session.identityId;
      
      if (!canDelete) {
        return res.status(403).json({ error: 'You can only delete your own attachments' });
      }

      if (attachment.storage_path) {
        const { error: storageError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .remove([attachment.storage_path]);

        if (storageError) {
          console.error('[Attachments] Storage delete error:', storageError);
        }
      }

      if (access.card.cover_image === attachment.url) {
        await supabase
          .from('project_card')
          .update({ cover_image: null })
          .eq('id', cardId);
      }

      const { error: deleteError } = await supabase
        .from('project_card_attachment')
        .delete()
        .eq('id', attachmentId);

      if (deleteError) {
        console.error('[Attachments] Delete error:', deleteError);
        return res.status(500).json({ error: 'Failed to delete attachment' });
      }

      await supabase.from('project_card_activity').insert({
        card_id: cardId,
        identity_id: session.identityId,
        action_type: 'attachment_deleted',
        action_data: { fileName: attachment.name }
      });

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Attachments] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
