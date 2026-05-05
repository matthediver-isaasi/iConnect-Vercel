import { getCallerEmsAccess } from '../_lib/memberGroupEmsAccess.js';

/**
 * GET /api/member-campaigns/qualifying-groups
 * Returns the list of MemberGroup entries the caller may send group emails
 * for, with their assigned role and the group's full role list (so the
 * client can offer the optional in-group role audience filter).
 *
 * Returns 200 with an empty list when the caller is a valid member but
 * doesn't qualify anywhere — this is the discovery endpoint the GroupEmail
 * page polls before deciding whether to redirect, so it intentionally
 * returns the empty access set rather than 403. All other member-campaigns
 * endpoints DO hard-fail with 403 when the caller has no qualifying groups.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const access = await getCallerEmsAccess(req);
  if (access.error) {
    return res.status(access.status).json({ error: access.error });
  }

  return res.json({
    success: true,
    groups: access.groups.map((g) => ({
      id: g.groupId,
      name: g.groupName,
      callerRole: g.role,
      roles: g.allRoles,
    })),
  });
}
