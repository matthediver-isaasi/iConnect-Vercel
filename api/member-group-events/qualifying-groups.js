import { getCallerGroupEventsAccess } from '../_lib/memberGroupEventsAccess.js';
import { supabase } from '../_lib/database.js';

/**
 * GET /api/member-group-events/qualifying-groups
 * Returns groups the caller belongs to that have events_enabled = true.
 * Each group lists upcoming + past group events plus the caller's existing
 * RSVP for each. `canCreate` flag tells the UI whether to render "New event".
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

  const { data: events, error: eventsErr } = await supabase
    .from('event')
    .select('id, title, slug, start_date, end_date, location, is_online, image_url, event_state, member_group_id, created_by')
    .eq('tenant_id', access.tenantContext.tenantId)
    .in('member_group_id', groupIds)
    .order('start_date', { ascending: true });

  if (eventsErr) {
    console.error('[member-group-events/qualifying-groups] events lookup failed:', eventsErr.message);
    return res.status(500).json({ error: 'Failed to load events' });
  }

  const eventIds = (events || []).map((e) => e.id);
  let rsvpsByEvent = new Map();
  let rsvpCounts = new Map();
  if (eventIds.length > 0) {
    if (access.identityId) {
      const { data: myRsvps } = await supabase
        .from('event_rsvp')
        .select('event_id, response')
        .eq('identity_id', access.identityId)
        .in('event_id', eventIds);
      (myRsvps || []).forEach((r) => rsvpsByEvent.set(r.event_id, r.response));
    }
    const { data: allRsvps } = await supabase
      .from('event_rsvp')
      .select('event_id, response')
      .in('event_id', eventIds);
    (allRsvps || []).forEach((r) => {
      if (!rsvpCounts.has(r.event_id)) rsvpCounts.set(r.event_id, { going: 0, not_going: 0, maybe: 0 });
      rsvpCounts.get(r.event_id)[r.response] = (rsvpCounts.get(r.event_id)[r.response] || 0) + 1;
    });
  }

  const eventsByGroup = new Map();
  for (const ev of events || []) {
    if (!eventsByGroup.has(ev.member_group_id)) eventsByGroup.set(ev.member_group_id, []);
    eventsByGroup.get(ev.member_group_id).push({
      id: ev.id,
      title: ev.title,
      slug: ev.slug,
      start_date: ev.start_date,
      end_date: ev.end_date,
      location: ev.location,
      is_online: ev.is_online,
      image_url: ev.image_url,
      event_state: ev.event_state,
      created_by: ev.created_by,
      my_rsvp: rsvpsByEvent.get(ev.id) || null,
      rsvp_counts: rsvpCounts.get(ev.id) || { going: 0, not_going: 0, maybe: 0 },
    });
  }

  return res.json({
    success: true,
    groups: access.groups.map((g) => ({
      id: g.groupId,
      name: g.groupName,
      callerRole: g.role,
      canCreate: g.canCreate,
      events: eventsByGroup.get(g.groupId) || [],
    })),
  });
}
