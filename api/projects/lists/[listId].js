import { supabase } from '../../_lib/database.js';
import { getSession } from '../../_lib/session.js';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
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
  const { listId } = req.query;

  if (!listId) {
    return res.status(400).json({ error: 'List ID required' });
  }

  try {
    const access = await getBoardMembershipForList(listId, session.identityId);
    if (!access?.membership) {
      return res.status(403).json({ error: 'Not a member of this board' });
    }

    if (req.method === 'GET') {
      const { data: list, error } = await supabase
        .from('project_list')
        .select('*')
        .eq('id', listId)
        .single();

      if (error || !list) {
        return res.status(404).json({ error: 'List not found' });
      }

      return res.json({ list });
    }

    if (req.method === 'PATCH') {
      if (access.membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot update lists' });
      }

      const { name, position, color, is_archived } = req.body;

      const updateData = { updated_at: new Date().toISOString() };
      if (name !== undefined) updateData.name = name.trim();
      if (position !== undefined) updateData.position = position;
      if (color !== undefined) updateData.color = color;
      if (is_archived !== undefined) updateData.is_archived = is_archived;

      const { data: updated, error } = await supabase
        .from('project_list')
        .update(updateData)
        .eq('id', listId)
        .select()
        .single();

      if (error) {
        console.error('[List] Update error:', error);
        return res.status(500).json({ error: 'Failed to update list' });
      }

      return res.json({ list: updated });
    }

    if (req.method === 'DELETE') {
      if (!['owner', 'admin'].includes(access.membership.role)) {
        return res.status(403).json({ error: 'Only owners/admins can delete lists' });
      }

      const { error } = await supabase
        .from('project_list')
        .delete()
        .eq('id', listId);

      if (error) {
        console.error('[List] Delete error:', error);
        return res.status(500).json({ error: 'Failed to delete list' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[List] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
