import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';

async function getBoardMembership(db, boardId, identityId) {
  const { data, error } = await db
    .from('project_board_member')
    .select('role')
    .eq('board_id', boardId)
    .eq('identity_id', identityId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function createAvailableUsersHandler({ db = supabase, sessionFor = getSession } = {}) {
return async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!db) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionResult = await sessionFor(req);
  if (!sessionResult?.data) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = sessionResult.data;
  const { boardId } = req.query;
  const { search, role_id: roleId } = req.query;

  if (!boardId) {
    return res.status(400).json({ error: 'Board ID required' });
  }

  try {
    const membership = await getBoardMembership(db, boardId, session.identityId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return res.status(403).json({ error: 'Only owners/admins can view available users' });
    }

    if (!session.tenantId) return res.status(403).json({ error: 'Tenant required' });
    if ((search !== undefined && typeof search !== 'string') ||
        (roleId !== undefined && (typeof roleId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roleId)))) {
      return res.status(400).json({ error: 'Invalid search or member role' });
    }
    if (roleId !== undefined) {
      const role = await db.from('role').select('id')
        .eq('id', roleId).eq('tenant_id', session.tenantId).maybeSingle();
      if (role.error) throw role.error;
      if (!role.data) return res.status(400).json({ error: 'Invalid member role' });
    }

    const { data: existingMembers, error: existingError } = await db
      .from('project_board_member')
      .select('identity_id')
      .eq('board_id', boardId);
    if (existingError) throw existingError;

    const existingIds = existingMembers?.map(m => m.identity_id) || [];

    let query = db
      .from('member')
      .select('identity_id, tenant_identity!inner(id, email, first_name, last_name, avatar_url)')
      .eq('tenant_id', session.tenantId)
      .not('identity_id', 'is', null)
      .order('created_on', { ascending: false });

    if (roleId) query = query.eq('role_id', roleId);

    if (existingIds.length > 0) {
      query = query.not('identity_id', 'in', `(${existingIds.join(',')})`);
    }

    if (search?.trim()) {
      const searchTerm = JSON.stringify(`%${search.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
      query = query.or(`email.ilike.${searchTerm},first_name.ilike.${searchTerm},last_name.ilike.${searchTerm}`);
    }

    const { data: members, error } = await query.limit(20);

    if (error) {
      console.error('[Available Users] Error:', error);
      return res.status(500).json({ error: 'Failed to fetch users' });
    }

    const seen = new Set();
    const users = (members || [])
      .map(m => m.tenant_identity)
      .filter(Boolean)
      .filter(u => {
        if (seen.has(u.id)) return false;
        seen.add(u.id);
        return true;
      });

    return res.json({ users: users || [] });
  } catch (err) {
    console.error('[Available Users] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
}

export default createAvailableUsersHandler();
