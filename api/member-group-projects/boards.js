import { supabase } from '../_lib/database.js';
import {
  getCallerProjectsAccess,
  requireProjectsGroupAccess,
  syncProjectBoardMembersForGroup,
} from '../_lib/memberGroupProjectsAccess.js';

/**
 * POST /api/member-group-projects/boards
 * Body: { memberGroupId, name, color? }
 * Creates a new project_board linked to memberGroupId, adds the caller as
 * 'admin', seeds default labels, then runs the sync helper so all qualifying
 * members are added as 'member'.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const access = await getCallerProjectsAccess(req);
  if (access.error) {
    return res.status(access.status).json({ error: access.error });
  }

  const { memberGroupId, name, color } = req.body || {};
  if (!memberGroupId || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'memberGroupId and name are required' });
  }

  const groupAccess = requireProjectsGroupAccess(access.groups, memberGroupId);
  if (!groupAccess) {
    return res.status(403).json({ error: 'You do not qualify to create boards for this group' });
  }

  if (!access.identityId) {
    return res.status(403).json({ error: 'Caller has no identity record' });
  }

  const tenantId = access.tenantContext.tenantId;

  const { data: board, error: createErr } = await supabase
    .from('project_board')
    .insert({
      tenant_id: tenantId,
      name: name.trim(),
      color: color || '#6366f1',
      visibility: 'private',
      member_group_id: memberGroupId,
      created_by: access.identityId,
    })
    .select()
    .single();

  if (createErr || !board) {
    console.error('[member-group-projects/boards] create failed:', createErr?.message);
    return res.status(500).json({ error: 'Failed to create board' });
  }

  const { error: addAdminErr } = await supabase
    .from('project_board_member')
    .insert({
      board_id: board.id,
      identity_id: access.identityId,
      role: 'admin',
      added_by: access.identityId,
    });
  if (addAdminErr) {
    console.error('[member-group-projects/boards] add admin failed:', addAdminErr.message);
    await supabase.from('project_board').delete().eq('id', board.id);
    return res.status(500).json({ error: 'Failed to add board admin' });
  }

  const defaultLabels = [
    { name: 'High Priority', color: '#ef4444' },
    { name: 'Medium Priority', color: '#f59e0b' },
    { name: 'Low Priority', color: '#22c55e' },
    { name: 'Bug', color: '#dc2626' },
    { name: 'Feature', color: '#3b82f6' },
    { name: 'Enhancement', color: '#8b5cf6' },
  ];
  await supabase.from('project_label').insert(
    defaultLabels.map((l) => ({ board_id: board.id, name: l.name, color: l.color }))
  );

  await syncProjectBoardMembersForGroup(memberGroupId);

  return res.status(201).json({ board: { ...board, user_role: 'admin' } });
}
