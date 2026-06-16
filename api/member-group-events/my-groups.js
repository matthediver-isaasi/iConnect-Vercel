import { getCallerGroupMembershipIds } from '../_lib/memberGroupEventsAccess.js';

/**
 * GET /api/member-group-events/my-groups
 * Returns the set of member_group ids the caller is an ACTIVE member of
 * (regardless of Group Admin flag). Used by the client to decide /Events
 * visibility of group-only events (group_event_public = false). Anonymous /
 * non-member callers get an empty list.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { groupIds } = await getCallerGroupMembershipIds(req);
    return res.json({ success: true, groupIds: Array.from(groupIds || []) });
  } catch (err) {
    console.error('[member-group-events/my-groups] error:', err.message);
    return res.json({ success: true, groupIds: [] });
  }
}
