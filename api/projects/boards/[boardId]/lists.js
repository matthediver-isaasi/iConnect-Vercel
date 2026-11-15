import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';
import { guardSalesLinkedProject } from '../../../_lib/salesLinkedProjectGuard.js';

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
    if (!await guardSalesLinkedProject(req, res, boardId,
      req.method === 'POST' ? 'projects.board-view.create-lists' : 'projects.board-view')) return;

    if (req.method === 'GET') {
      const { data: lists, error } = await supabase
        .from('project_list')
        .select('*')
        .eq('board_id', boardId)
        .eq('is_archived', false)
        .order('position', { ascending: true })
        .order('id', { ascending: true });

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

      const { lists } = req.body || {};

      if (!Array.isArray(lists) || lists.some(item => !item || typeof item.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)) ||
        new Set(lists.map(item => item.id.toLowerCase())).size !== lists.length) {
        return res.status(400).json({ error: 'A complete list of unique list IDs is required' });
      }

      const { data, error } = await supabase.rpc('reorder_project_lists', {
        p_board_id: boardId, p_tenant_id: session.tenantId,
        p_identity_id: session.identityId, p_list_ids: lists.map(item => item.id),
      });
      if (error) {
        const status = error.code === 'PT409' ? 409 : error.code === '42501' ? 403 : 500;
        return res.status(status).json({ error: status === 409
          ? 'Lists changed. Reload the board and try again.' : 'Failed to reorder lists' });
      }
      return res.json({ success: true, lists: data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Lists] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
