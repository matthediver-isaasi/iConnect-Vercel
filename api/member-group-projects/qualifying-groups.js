import { getCallerProjectsAccess, syncProjectBoardMembersForGroup } from '../_lib/memberGroupProjectsAccess.js';
import { supabase } from '../_lib/database.js';

/**
 * GET /api/member-group-projects/qualifying-groups
 * Returns the list of MemberGroups the caller qualifies for, with each
 * group's non-archived boards (id, name, color). Lazily runs the membership
 * sync for each qualifying group so the caller's project_board_member rows
 * are guaranteed to be in place before they navigate to a board.
 *
 * Returns 200 with empty list when the caller is a valid member but doesn't
 * qualify — the page polls this before deciding whether to redirect.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const access = await getCallerProjectsAccess(req);
  if (access.error) {
    return res.status(access.status).json({ error: access.error });
  }

  if (access.groups.length === 0) {
    return res.json({ success: true, groups: [] });
  }

  // Lazy sync as a safety net so caller is always present in their boards.
  await Promise.all(access.groups.map((g) => syncProjectBoardMembersForGroup(g.groupId)));

  const groupIds = access.groups.map((g) => g.groupId);
  const { data: boards, error: boardsErr } = await supabase
    .from('project_board')
    .select('id, name, color, member_group_id, is_archived')
    .in('member_group_id', groupIds)
    .eq('is_archived', false)
    .order('created_at', { ascending: false });

  if (boardsErr) {
    console.error('[qualifying-groups] boards lookup failed:', boardsErr.message);
    return res.status(500).json({ error: 'Failed to load boards' });
  }

  const boardsByGroup = new Map();
  (boards || []).forEach((b) => {
    if (!boardsByGroup.has(b.member_group_id)) boardsByGroup.set(b.member_group_id, []);
    boardsByGroup.get(b.member_group_id).push({ id: b.id, name: b.name, color: b.color });
  });

  return res.json({
    success: true,
    groups: access.groups.map((g) => ({
      id: g.groupId,
      name: g.groupName,
      callerRole: g.role,
      roles: g.allRoles,
      boards: boardsByGroup.get(g.groupId) || [],
    })),
  });
}
