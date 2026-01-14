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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
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
  const { boardId } = req.query;
  const { search } = req.query;

  if (!boardId) {
    return res.status(400).json({ error: 'Board ID required' });
  }

  try {
    const membership = await getBoardMembership(boardId, session.identityId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return res.status(403).json({ error: 'Only owners/admins can view available users' });
    }

    const { data: existingMembers } = await supabase
      .from('project_board_member')
      .select('identity_id')
      .eq('board_id', boardId);

    const existingIds = existingMembers?.map(m => m.identity_id) || [];

    let query = supabase
      .from('tenant_identity')
      .select('id, email, first_name, last_name, profile_picture_url')
      .eq('tenant_id', session.tenantId)
      .order('first_name', { ascending: true })
      .limit(20);

    if (existingIds.length > 0) {
      query = query.not('id', 'in', `(${existingIds.join(',')})`);
    }

    if (search?.trim()) {
      const searchTerm = `%${search.trim().toLowerCase()}%`;
      query = query.or(`email.ilike.${searchTerm},first_name.ilike.${searchTerm},last_name.ilike.${searchTerm}`);
    }

    const { data: users, error } = await query;

    if (error) {
      console.error('[Available Users] Error:', error);
      return res.status(500).json({ error: 'Failed to fetch users' });
    }

    return res.json({ users: users || [] });
  } catch (err) {
    console.error('[Available Users] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
