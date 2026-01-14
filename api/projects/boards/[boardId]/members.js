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
      const { data: members, error } = await supabase
        .from('project_board_member')
        .select('*')
        .eq('board_id', boardId);

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch members' });
      }

      const identityIds = members?.map(m => m.identity_id) || [];
      let identities = [];
      if (identityIds.length > 0) {
        const { data } = await supabase
          .from('tenant_identity')
          .select('id, email, first_name, last_name, profile_picture_url')
          .in('id', identityIds);
        identities = data || [];
      }

      const enrichedMembers = members?.map(m => {
        const identity = identities.find(i => i.id === m.identity_id);
        return {
          ...m,
          email: identity?.email,
          first_name: identity?.first_name,
          last_name: identity?.last_name,
          profile_picture_url: identity?.profile_picture_url
        };
      }) || [];

      return res.json({ members: enrichedMembers });
    }

    if (req.method === 'POST') {
      if (!['owner', 'admin'].includes(membership.role)) {
        return res.status(403).json({ error: 'Only owners/admins can add members' });
      }

      const { identity_id, role } = req.body;

      if (!identity_id) {
        return res.status(400).json({ error: 'Identity ID required' });
      }

      const { data: identity } = await supabase
        .from('tenant_identity')
        .select('id')
        .eq('id', identity_id)
        .eq('tenant_id', session.tenantId)
        .single();

      if (!identity) {
        return res.status(404).json({ error: 'User not found in tenant' });
      }

      const existingMembership = await getBoardMembership(boardId, identity_id);
      if (existingMembership) {
        return res.status(400).json({ error: 'User is already a member' });
      }

      const { data: newMember, error } = await supabase
        .from('project_board_member')
        .insert({
          board_id: boardId,
          identity_id: identity_id,
          role: role || 'member',
          added_by: session.identityId
        })
        .select()
        .single();

      if (error) {
        console.error('[Board Members] Error adding member:', error);
        return res.status(500).json({ error: 'Failed to add member' });
      }

      return res.status(201).json({ member: newMember });
    }

    if (req.method === 'DELETE') {
      if (!['owner', 'admin'].includes(membership.role)) {
        return res.status(403).json({ error: 'Only owners/admins can remove members' });
      }

      const { identity_id } = req.body;

      if (!identity_id) {
        return res.status(400).json({ error: 'Identity ID required' });
      }

      const targetMembership = await getBoardMembership(boardId, identity_id);
      if (!targetMembership) {
        return res.status(404).json({ error: 'Member not found' });
      }

      if (targetMembership.role === 'owner' && membership.role !== 'owner') {
        return res.status(403).json({ error: 'Cannot remove board owner' });
      }

      const { error } = await supabase
        .from('project_board_member')
        .delete()
        .eq('board_id', boardId)
        .eq('identity_id', identity_id);

      if (error) {
        return res.status(500).json({ error: 'Failed to remove member' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Board Members] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
