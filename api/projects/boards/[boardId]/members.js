import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';
import { boardMembershipError } from '../../../_lib/projectBoardOwnership.js';

async function getBoardMembership(db, boardId, identityId) {
  const { data, error } = await db
    .from('project_board_member')
    .select('role')
    .eq('board_id', boardId)
    .eq('identity_id', identityId)
    .single();
  if (error) throw error;
  return data;
}

export function createBoardMembersHandler({ db = supabase, sessionFor = getSession } = {}) {
  return (req, res) => handleBoardMembers(req, res, db, sessionFor);
}

async function handleBoardMembers(req, res, db, sessionFor) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!db) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionResult = await sessionFor(req);
  if (!sessionResult?.data?.tenantId || !sessionResult?.data?.identityId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = sessionResult.data;
  const { boardId } = req.query;

  if (!boardId) {
    return res.status(400).json({ error: 'Board ID required' });
  }

  try {
    const { data: board, error: boardError } = await db.from('project_board')
      .select('id').eq('id', boardId).eq('tenant_id', session.tenantId).maybeSingle();
    if (boardError) throw boardError;
    if (!board) return res.status(404).json({ error: 'Board not found' });
    const membership = await getBoardMembership(db, boardId, session.identityId);
    if (!membership) {
      return res.status(403).json({ error: 'Not a member of this board' });
    }

    if (req.method === 'GET') {
      const { data: members, error } = await db
        .from('project_board_member')
        .select('*')
        .eq('board_id', boardId);

      if (error) {
        return res.status(500).json({ error: 'Failed to fetch members' });
      }

      const identityIds = members?.map(m => m.identity_id) || [];
      let identities = [];
      if (identityIds.length > 0) {
        const { data, error: identitiesError } = await db
          .from('tenant_identity')
          .select('id, email, first_name, last_name, avatar_url')
          .in('id', identityIds);
        if (identitiesError) throw identitiesError;
        identities = data || [];
      }

      const enrichedMembers = members?.map(m => {
        const identity = identities.find(i => i.id === m.identity_id);
        return {
          ...m,
          email: identity?.email,
          first_name: identity?.first_name,
          last_name: identity?.last_name,
          avatar_url: identity?.avatar_url
        };
      }) || [];

      return res.json({ members: enrichedMembers });
    }

    if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      if (!['owner', 'admin'].includes(membership.role)) {
        return res.status(403).json({ error: 'Only owners/admins can manage members' });
      }
      const { identity_id, role } = req.body || {};
      if (typeof identity_id !== 'string' || !identity_id) {
        return res.status(400).json({ error: 'Identity ID required' });
      }
      const nextRole = req.method === 'POST' ? role || 'member' : role;
      if (req.method !== 'DELETE' && !['owner', 'admin', 'member', 'viewer'].includes(nextRole)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      if (nextRole === 'owner' && membership.role !== 'owner') {
        return res.status(403).json({ error: 'Only owners can assign owner role' });
      }
      const { data, error } = await db.rpc('change_project_board_member', {
        p_tenant: session.tenantId, p_board: boardId, p_actor: session.identityId,
        p_target: identity_id, p_action: { POST: 'add', PATCH: 'role', DELETE: 'remove' }[req.method],
        p_role: req.method === 'DELETE' ? null : nextRole,
      });
      if (error) {
        const failure = boardMembershipError(error);
        return res.status(failure.status).json({ error: failure.message });
      }
      if (!data) return res.status(500).json({ error: 'Membership change could not be confirmed' });
      if (req.method === 'POST') return res.status(201).json({ member: data });
      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Board Members] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

export default createBoardMembersHandler();
