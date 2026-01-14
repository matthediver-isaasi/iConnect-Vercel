import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';

async function getBoardMembershipForList(listId, identityId) {
  const { data: list } = await supabase
    .from('project_list')
    .select('board_id')
    .eq('id', listId)
    .single();

  if (!list) return null;

  const { data: membership } = await supabase
    .from('project_board_member')
    .select('role')
    .eq('board_id', list.board_id)
    .eq('identity_id', identityId)
    .single();

  return { list, membership };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { list_id, title, description, position, priority, due_date, start_date } = req.body;

    if (!list_id) {
      return res.status(400).json({ error: 'List ID is required' });
    }

    if (!title?.trim()) {
      return res.status(400).json({ error: 'Card title is required' });
    }

    const access = await getBoardMembershipForList(list_id, session.identityId);
    if (!access?.membership) {
      return res.status(403).json({ error: 'Not a member of this board' });
    }

    if (access.membership.role === 'viewer') {
      return res.status(403).json({ error: 'Viewers cannot create cards' });
    }

    let cardPosition = position;
    if (cardPosition === undefined) {
      const { data: maxCard } = await supabase
        .from('project_card')
        .select('position')
        .eq('list_id', list_id)
        .order('position', { ascending: false })
        .limit(1)
        .single();
      cardPosition = (maxCard?.position ?? -1) + 1;
    }

    const { data: card, error } = await supabase
      .from('project_card')
      .insert({
        list_id,
        board_id: access.list.board_id,
        title: title.trim(),
        description: description?.trim() || null,
        position: cardPosition,
        priority: priority || 'none',
        due_date: due_date || null,
        start_date: start_date || null,
        created_by: session.identityId
      })
      .select()
      .single();

    if (error) {
      console.error('[Cards] Error creating card:', error);
      return res.status(500).json({ error: 'Failed to create card' });
    }

    await supabase
      .from('project_card_activity')
      .insert({
        card_id: card.id,
        identity_id: session.identityId,
        action_type: 'created',
        action_data: { title: card.title }
      });

    return res.status(201).json({ card: { ...card, project_card_label: [], project_card_assignee: [] } });
  } catch (err) {
    console.error('[Cards] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
