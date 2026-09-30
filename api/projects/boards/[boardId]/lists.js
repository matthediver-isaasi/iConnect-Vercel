import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';

async function getBoardMembership(boardId, identityId) {
  const { data } = await supabase
    .from('project_board_member')
    .select('role')
    .eq('board_id', boardId)
    .eq('identity_id', identityId)
    .single();
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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
  const { boardId } = req.query;

  if (!boardId) {
    return res.status(400).json({ error: 'Board ID required' });
  }

  try {
    const membership = await getBoardMembership(boardId, session.identityId);
    if (!membership) {
      return res.status(403).json({ error: 'Not a member of this board' });
    }

    if (req.method === 'GET') {
      const { data: lists, error } = await supabase
        .from('project_list')
        .select('*')
        .eq('board_id', boardId)
        .eq('is_archived', false)
        .order('position', { ascending: true });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch lists' });
      }

      return res.json({ lists: lists || [] });
    }

    if (req.method === 'POST') {
      if (membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot create lists' });
      }

      const { name, position } = req.body;

      if (!name?.trim()) {
        return res.status(400).json({ error: 'List name is required' });
      }

      let listPosition = position;
      if (listPosition === undefined) {
        const { data: maxList } = await supabase
          .from('project_list')
          .select('position')
          .eq('board_id', boardId)
          .order('position', { ascending: false })
          .limit(1)
          .single();
        listPosition = (maxList?.position ?? -1) + 1;
      }

      const { data: list, error } = await supabase
        .from('project_list')
        .insert({
          board_id: boardId,
          name: name.trim(),
          position: listPosition
        })
        .select()
        .single();

      if (error) {
        console.error('[Lists] Error creating list:', error);
        return res.status(500).json({ error: 'Failed to create list' });
      }

      return res.status(201).json({ list });
    }

    if (req.method === 'PATCH') {
      if (membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot reorder lists' });
      }

      const { lists } = req.body;

      if (!Array.isArray(lists)) {
        return res.status(400).json({ error: 'Lists array required' });
      }

      const updates = lists.map((item, index) => 
        supabase
          .from('project_list')
          .update({ position: index, updated_at: new Date().toISOString() })
          .eq('id', item.id)
          .eq('board_id', boardId)
      );

      await Promise.all(updates);

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Lists] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
