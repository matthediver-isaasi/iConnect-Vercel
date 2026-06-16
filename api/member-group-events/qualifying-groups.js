import { getCallerGroupEventsAccess } from '../_lib/memberGroupEventsAccess.js';
import { supabase } from '../_lib/database.js';

/**
 * GET /api/member-group-events/qualifying-groups
 *
 * Task #1519 (T007): Group-Admin management listing.
 * Returns the events-enabled groups the caller administers, each with their
 * REAL events — simple `event` rows and `complex_event` rows — filtered by
 * member_group_id. The bespoke RSVP system is retired (T010), so no RSVP data
 * is surfaced here; group events are real events that live on /Events.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const access = await getCallerGroupEventsAccess(req);
  if (access.error) {
    return res.status(access.status).json({ error: access.error });
  }

  if (access.groups.length === 0) {
    return res.json({ success: true, groups: [] });
  }

  const groupIds = access.groups.map((g) => g.groupId);
  const tenantId = access.tenantContext.tenantId;

  const [
    { data: simpleEvents, error: simpleErr },
    { data: complexEvents, error: complexErr },
  ] = await Promise.all([
    supabase
      .from('event')
      .select('id, title, slug, start_date, end_date, location, is_online, image_url, image_focal_point, event_state, group_event_public, member_group_id')
      .eq('tenant_id', tenantId)
      .in('member_group_id', groupIds)
      .order('start_date', { ascending: true }),
    supabase
      .from('complex_event')
      .select('id, title, slug, start_date, end_date, location, is_online, image_url, event_state, group_event_public, member_group_id')
      .eq('tenant_id', tenantId)
      .in('member_group_id', groupIds)
      .order('start_date', { ascending: true }),
  ]);

  if (simpleErr || complexErr) {
    console.error(
      '[member-group-events/qualifying-groups] lookup failed:',
      simpleErr?.message || complexErr?.message
    );
    return res.status(500).json({ error: 'Failed to load events' });
  }

  const simpleByGroup = new Map();
  for (const ev of simpleEvents || []) {
    if (!simpleByGroup.has(ev.member_group_id)) simpleByGroup.set(ev.member_group_id, []);
    simpleByGroup.get(ev.member_group_id).push({ ...ev, is_complex: false });
  }

  const complexByGroup = new Map();
  for (const ev of complexEvents || []) {
    if (!complexByGroup.has(ev.member_group_id)) complexByGroup.set(ev.member_group_id, []);
    complexByGroup.get(ev.member_group_id).push({ ...ev, is_complex: true });
  }

  return res.json({
    success: true,
    groups: access.groups.map((g) => ({
      id: g.groupId,
      name: g.groupName,
      callerRole: g.role,
      canCreate: g.canCreate,
      events: simpleByGroup.get(g.groupId) || [],
      complexEvents: complexByGroup.get(g.groupId) || [],
    })),
  });
}
