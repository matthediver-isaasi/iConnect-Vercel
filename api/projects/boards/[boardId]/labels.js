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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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
      const { data: labels, error } = await supabase
        .from('project_label')
        .select('*')
        .eq('board_id', boardId)
        .order('created_at', { ascending: true });

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch labels' });
      }

      return res.json({ labels: labels || [] });
    }

    if (req.method === 'POST') {
      if (!['owner', 'admin'].includes(membership.role)) {
        return res.status(403).json({ error: 'Only owners/admins can create labels' });
      }

      const { name, color } = req.body;

      if (!name?.trim()) {
        return res.status(400).json({ error: 'Label name is required' });
      }

      if (!color) {
        return res.status(400).json({ error: 'Label color is required' });
      }

      const { data: label, error } = await supabase
        .from('project_label')
        .insert({
          board_id: boardId,
          name: name.trim(),
          color
        })
        .select()
        .single();

      if (error) {
        console.error('[Labels] Error creating:', error);
        return res.status(500).json({ error: 'Failed to create label' });
      }

      return res.status(201).json({ label });
    }

    if (req.method === 'PATCH') {
      if (!['owner', 'admin'].includes(membership.role)) {
        return res.status(403).json({ error: 'Only owners/admins can update labels' });
      }

      const { id, name, color } = req.body;

      if (!id) {
        return res.status(400).json({ error: 'Label ID required' });
      }

      const updateData = {};
      if (name !== undefined) updateData.name = name.trim();
      if (color !== undefined) updateData.color = color;

      const { data: label, error } = await supabase
        .from('project_label')
        .update(updateData)
        .eq('id', id)
        .eq('board_id', boardId)
        .select()
        .single();

      if (error) {
        console.error('[Labels] Error updating:', error);
        return res.status(500).json({ error: 'Failed to update label' });
      }

      return res.json({ label });
    }

    if (req.method === 'DELETE') {
      if (!['owner', 'admin'].includes(membership.role)) {
        return res.status(403).json({ error: 'Only owners/admins can delete labels' });
      }

      const { id } = req.body;

      if (!id) {
        return res.status(400).json({ error: 'Label ID required' });
      }

      const { error } = await supabase
        .from('project_label')
        .delete()
        .eq('id', id)
        .eq('board_id', boardId);

      if (error) {
        return res.status(500).json({ error: 'Failed to delete label' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Labels] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
