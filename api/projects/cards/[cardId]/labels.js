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
      const { data: cardLabels, error } = await supabase
        .from('project_card_label')
        .select('label_id')
        .eq('card_id', cardId);

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch labels' });
      }

      return res.json({ labels: cardLabels || [] });
    }

    if (req.method === 'POST') {
      if (access.membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot add labels' });
      }

      const { label_id } = req.body;

      if (!label_id) {
        return res.status(400).json({ error: 'Label ID required' });
      }

      const { data: label } = await supabase
        .from('project_label')
        .select('id')
        .eq('id', label_id)
        .eq('board_id', access.card.board_id)
        .single();

      if (!label) {
        return res.status(404).json({ error: 'Label not found' });
      }

      const { data: existing } = await supabase
        .from('project_card_label')
        .select('id')
        .eq('card_id', cardId)
        .eq('label_id', label_id)
        .single();

      if (existing) {
        return res.status(400).json({ error: 'Label already applied' });
      }

      const { data: cardLabel, error } = await supabase
        .from('project_card_label')
        .insert({ card_id: cardId, label_id })
        .select()
        .single();

      if (error) {
        console.error('[Card Labels] Error adding:', error);
        return res.status(500).json({ error: 'Failed to add label' });
      }

      return res.status(201).json({ cardLabel });
    }

    if (req.method === 'DELETE') {
      if (access.membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot remove labels' });
      }

      const { label_id } = req.body;

      if (!label_id) {
        return res.status(400).json({ error: 'Label ID required' });
      }

      const { error } = await supabase
        .from('project_card_label')
        .delete()
        .eq('card_id', cardId)
        .eq('label_id', label_id);

      if (error) {
        return res.status(500).json({ error: 'Failed to remove label' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Card Labels] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
