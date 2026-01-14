import { supabase } from '../../_lib/database.js';
import { getSession } from '../../_lib/session.js';

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
      const { data: board, error } = await supabase
        .from('project_board')
        .select('*')
        .eq('id', boardId)
        .eq('tenant_id', session.tenantId)
        .single();

      if (error || !board) {
        return res.status(404).json({ error: 'Board not found' });
      }

      const { data: lists } = await supabase
        .from('project_list')
        .select('*')
        .eq('board_id', boardId)
        .eq('is_archived', false)
        .order('position', { ascending: true });

      const { data: cards } = await supabase
        .from('project_card')
        .select(`
          *,
          project_card_label(label_id),
          project_card_assignee(identity_id)
        `)
        .eq('board_id', boardId)
        .eq('is_archived', false)
        .order('position', { ascending: true });

      const { data: labels } = await supabase
        .from('project_label')
        .select('*')
        .eq('board_id', boardId);

      const { data: members } = await supabase
        .from('project_board_member')
        .select('identity_id, role, added_at')
        .eq('board_id', boardId);

      const memberIdentityIds = members?.map(m => m.identity_id) || [];
      let memberDetails = [];
      if (memberIdentityIds.length > 0) {
        const { data: identities } = await supabase
          .from('tenant_identity')
          .select('id, email, first_name, last_name, profile_picture_url')
          .in('id', memberIdentityIds);
        memberDetails = identities || [];
      }

      const enrichedMembers = members?.map(m => {
        const identity = memberDetails.find(i => i.id === m.identity_id);
        return {
          ...m,
          email: identity?.email,
          first_name: identity?.first_name,
          last_name: identity?.last_name,
          profile_picture_url: identity?.profile_picture_url
        };
      }) || [];

      return res.json({
        board: { ...board, user_role: membership.role },
        lists: lists || [],
        cards: cards || [],
        labels: labels || [],
        members: enrichedMembers
      });
    }

    if (req.method === 'PATCH') {
      if (!['owner', 'admin'].includes(membership.role)) {
        return res.status(403).json({ error: 'Only board owners/admins can update' });
      }

      const { name, description, color, background_image, is_archived, visibility, settings } = req.body;

      const updateData = {};
      if (name !== undefined) updateData.name = name.trim();
      if (description !== undefined) updateData.description = description?.trim() || null;
      if (color !== undefined) updateData.color = color;
      if (background_image !== undefined) updateData.background_image = background_image;
      if (is_archived !== undefined) updateData.is_archived = is_archived;
      if (visibility !== undefined) updateData.visibility = visibility;
      if (settings !== undefined) updateData.settings = settings;
      updateData.updated_at = new Date().toISOString();

      const { data: updated, error } = await supabase
        .from('project_board')
        .update(updateData)
        .eq('id', boardId)
        .select()
        .single();

      if (error) {
        console.error('[Board] Update error:', error);
        return res.status(500).json({ error: 'Failed to update board' });
      }

      return res.json({ board: { ...updated, user_role: membership.role } });
    }

    if (req.method === 'DELETE') {
      if (membership.role !== 'owner') {
        return res.status(403).json({ error: 'Only board owner can delete' });
      }

      const { error } = await supabase
        .from('project_board')
        .delete()
        .eq('id', boardId);

      if (error) {
        console.error('[Board] Delete error:', error);
        return res.status(500).json({ error: 'Failed to delete board' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Board] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
