import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';
import { guardSalesLinkedProject } from '../../../_lib/salesLinkedProjectGuard.js';

async function getBoardMembershipForCard(cardId, identityId) {
  const { data: card } = await supabase
    .from('project_card')
    .select('board_id')
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
    if (!await guardSalesLinkedProject(req, res, access.card.board_id)) return;

    if (req.method === 'GET') {
      const { data: comments, error } = await supabase
        .from('project_card_comment')
        .select('*, images:project_comment_image(attachment:project_card_attachment(id,name,url,file_type,file_size))')
        .eq('card_id', cardId)
        .order('created_at', { ascending: true });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch comments' });
      }

      const identityIds = [...new Set(comments?.map(c => c.identity_id) || [])];
      let identities = [];
      if (identityIds.length > 0) {
        const { data } = await supabase
          .from('tenant_identity')
          .select('id, email, first_name, last_name, avatar_url')
          .in('id', identityIds);
        identities = data || [];
      }

      const enrichedComments = comments?.map(c => {
        const identity = identities.find(i => i.id === c.identity_id);
        return {
          ...c,
          author: {
            id: identity?.id,
            email: identity?.email,
            first_name: identity?.first_name,
            last_name: identity?.last_name,
            avatar_url: identity?.avatar_url
          }
        };
      }) || [];

      return res.json({ comments: enrichedComments });
    }

    if (req.method === 'POST') {
      if (access.membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot comment' });
      }

      const { content, mentionIdentityIds = [], attachmentIds = [], requestId } = req.body || {};
      const uuid = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || attachmentIds.some(id => !uuid(id))
        || (requestId !== undefined && !uuid(requestId)) || (attachmentIds.length && !requestId)) {
        return res.status(400).json({ error: 'Invalid comment images or request ID' });
      }

      if (typeof content !== 'string' || (!content.trim() && !attachmentIds.length) || content.length > 20000) {
        return res.status(400).json({ error: 'Comment content is required' });
      }
      if (!Array.isArray(mentionIdentityIds) || mentionIdentityIds.length > 50
        || mentionIdentityIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
        return res.status(400).json({ error: 'Invalid mention recipients' });
      }

      const { data: comment, error } = await supabase
        .rpc(requestId ? 'create_project_comment_with_images' : 'create_project_comment_with_mentions', {
          p_card_id: cardId, p_actor_id: session.identityId,
          p_content: content.trim(), p_recipient_ids: [...new Set(mentionIdentityIds)],
          ...(requestId ? { p_attachment_ids: [...new Set(attachmentIds)], p_request_id: requestId } : {})
        });

      if (error) {
        if (error.code === '22023') return res.status(400).json({ error: error.message });
        if (error.code === '42501') return res.status(403).json({ error: 'Not allowed to comment on this board' });
        if (error.code === 'P0002') return res.status(404).json({ error: 'Card or board unavailable' });
        console.error('[Comments] Error creating:', error.code);
        return res.status(500).json({ error: 'Failed to create comment' });
      }

      const { data: identity } = await supabase
        .from('tenant_identity')
        .select('id, email, first_name, last_name, avatar_url')
        .eq('id', session.identityId)
        .single();

      return res.status(201).json({
        comment: {
          ...comment,
          author: {
            id: identity?.id,
            email: identity?.email,
            first_name: identity?.first_name,
            last_name: identity?.last_name,
            avatar_url: identity?.avatar_url
          }
        }
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Comments] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
