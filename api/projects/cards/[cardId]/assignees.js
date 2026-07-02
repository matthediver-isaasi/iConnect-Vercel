import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';

async function getBoardMembershipForCard(cardId, identityId) {
  const { data: card } = await supabase
    .from('project_card')
    .select('board_id, title')
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
      const { data: assignees, error } = await supabase
        .from('project_card_assignee')
        .select('*')
        .eq('card_id', cardId);

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch assignees' });
      }

      return res.json({ assignees: assignees || [] });
    }

    if (req.method === 'POST') {
      if (access.membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot assign cards' });
      }

      const { identity_id } = req.body;

      if (!identity_id) {
        return res.status(400).json({ error: 'Identity ID required' });
      }

      const { data: boardMember } = await supabase
        .from('project_board_member')
        .select('identity_id')
        .eq('board_id', access.card.board_id)
        .eq('identity_id', identity_id)
        .single();

      if (!boardMember) {
        return res.status(400).json({ error: 'User must be a board member to be assigned' });
      }

      const { data: existing } = await supabase
        .from('project_card_assignee')
        .select('id')
        .eq('card_id', cardId)
        .eq('identity_id', identity_id)
        .single();

      if (existing) {
        return res.status(400).json({ error: 'User is already assigned' });
      }

      const { data: assignee, error } = await supabase
        .from('project_card_assignee')
        .insert({
          card_id: cardId,
          identity_id,
          assigned_by: session.identityId
        })
        .select()
        .single();

      if (error) {
        console.error('[Assignees] Error adding:', error);
        return res.status(500).json({ error: 'Failed to add assignee' });
      }

      await supabase.from('project_card_activity').insert({
        card_id: cardId,
        identity_id: session.identityId,
        action_type: 'assigned',
        action_data: { assignee_id: identity_id }
      });

      return res.status(201).json({ assignee });
    }

    if (req.method === 'DELETE') {
      if (access.membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot unassign cards' });
      }

      const { identity_id } = req.body;

      if (!identity_id) {
        return res.status(400).json({ error: 'Identity ID required' });
      }

      const { error } = await supabase
        .from('project_card_assignee')
        .delete()
        .eq('card_id', cardId)
        .eq('identity_id', identity_id);

      if (error) {
        return res.status(500).json({ error: 'Failed to remove assignee' });
      }

      await supabase.from('project_card_activity').insert({
        card_id: cardId,
        identity_id: session.identityId,
        action_type: 'unassigned',
        action_data: { assignee_id: identity_id }
      });

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Assignees] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
