import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';

async function getBoardMembershipForCard(cardId, identityId) {
  const { data: card } = await supabase
    .from('project_card')
    .select('board_id, list_id, position')
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
  const { list_id, position } = req.body;

  if (!cardId) {
    return res.status(400).json({ error: 'Card ID required' });
  }

  if (list_id === undefined || position === undefined) {
    return res.status(400).json({ error: 'list_id and position are required' });
  }

  try {
    const access = await getBoardMembershipForCard(cardId, session.identityId);
    if (!access?.membership) {
      return res.status(403).json({ error: 'Not a member of this board' });
    }

    if (access.membership.role === 'viewer') {
      return res.status(403).json({ error: 'Viewers cannot move cards' });
    }

    const oldListId = access.card.list_id;
    const oldPosition = access.card.position;
    const sameList = oldListId === list_id;

    if (sameList) {
      if (position > oldPosition) {
        await supabase
          .from('project_card')
          .update({ position: supabase.rpc ? position : position })
          .gt('position', oldPosition)
          .lte('position', position)
          .eq('list_id', list_id)
          .neq('id', cardId);

        const { data: cardsToUpdate } = await supabase
          .from('project_card')
          .select('id, position')
          .eq('list_id', list_id)
          .gt('position', oldPosition)
          .lte('position', position)
          .neq('id', cardId);

        for (const card of cardsToUpdate || []) {
          await supabase
            .from('project_card')
            .update({ position: card.position - 1 })
            .eq('id', card.id);
        }
      } else if (position < oldPosition) {
        const { data: cardsToUpdate } = await supabase
          .from('project_card')
          .select('id, position')
          .eq('list_id', list_id)
          .gte('position', position)
          .lt('position', oldPosition)
          .neq('id', cardId);

        for (const card of cardsToUpdate || []) {
          await supabase
            .from('project_card')
            .update({ position: card.position + 1 })
            .eq('id', card.id);
        }
      }
    } else {
      const { data: cardsInOldList } = await supabase
        .from('project_card')
        .select('id, position')
        .eq('list_id', oldListId)
        .gt('position', oldPosition);

      for (const card of cardsInOldList || []) {
        await supabase
          .from('project_card')
          .update({ position: card.position - 1 })
          .eq('id', card.id);
      }

      const { data: cardsInNewList } = await supabase
        .from('project_card')
        .select('id, position')
        .eq('list_id', list_id)
        .gte('position', position);

      for (const card of cardsInNewList || []) {
        await supabase
          .from('project_card')
          .update({ position: card.position + 1 })
          .eq('id', card.id);
      }
    }

    const { data: updated, error } = await supabase
      .from('project_card')
      .update({
        list_id,
        position,
        updated_at: new Date().toISOString()
      })
      .eq('id', cardId)
      .select(`
        *,
        project_card_label(label_id),
        project_card_assignee(identity_id)
      `)
      .single();

    if (error) {
      console.error('[Card Move] Error:', error);
      return res.status(500).json({ error: 'Failed to move card' });
    }

    if (!sameList) {
      await supabase.from('project_card_activity').insert({
        card_id: cardId,
        identity_id: session.identityId,
        action_type: 'moved',
        action_data: { from_list: oldListId, to_list: list_id }
      });
    }

    return res.json({ card: updated });
  } catch (err) {
    console.error('[Card Move] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
