import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';

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

    if (req.method === 'GET') {
      const { data: comments, error } = await supabase
        .from('project_card_comment')
        .select('*')
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
          .select('id, email, first_name, last_name, profile_picture_url')
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
            profile_picture_url: identity?.profile_picture_url
          }
        };
      }) || [];

      return res.json({ comments: enrichedComments });
    }

    if (req.method === 'POST') {
      if (access.membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot comment' });
      }

      const { content } = req.body;

      if (!content?.trim()) {
        return res.status(400).json({ error: 'Comment content is required' });
      }

      const { data: comment, error } = await supabase
        .from('project_card_comment')
        .insert({
          card_id: cardId,
          identity_id: session.identityId,
          content: content.trim()
        })
        .select()
        .single();

      if (error) {
        console.error('[Comments] Error creating:', error);
        return res.status(500).json({ error: 'Failed to create comment' });
      }

      const { data: identity } = await supabase
        .from('tenant_identity')
        .select('id, email, first_name, last_name, profile_picture_url')
        .eq('id', session.identityId)
        .single();

      await supabase.from('project_card_activity').insert({
        card_id: cardId,
        identity_id: session.identityId,
        action_type: 'commented',
        action_data: { comment_id: comment.id }
      });

      return res.status(201).json({
        comment: {
          ...comment,
          author: {
            id: identity?.id,
            email: identity?.email,
            first_name: identity?.first_name,
            last_name: identity?.last_name,
            profile_picture_url: identity?.profile_picture_url
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
