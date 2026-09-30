// Public agenda lines for a Training event (Task #3419).
// Mirrors /api/complex-event-sessions/public: tenant-resolved, id-scoped,
// returns per-line type/dates/description plus the visible detail (location,
// per-line speakers/sponsors — Task #3436).
//
// Paid-only links (Task #3436): the Zoom join URL and LMS URL are only
// included when the requesting viewer is entitled — i.e. logged in with a
// confirmed booking for this event, matched either as the booker (member_id)
// or as a named attendee (attendee_email). Everyone else gets the agenda
// without those links; hiding is server-side so they can't be scraped.

import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getSessionMember } from '../_lib/session.js';
import { emailExactIlikePattern } from '../_lib/viewerBookingMatch.js';

async function viewerHasConfirmedBooking(eventId, tenantId, member) {
  if (!member) return false;
  const memberTenantId = member.tenant_id || member.organization?.tenant_id || null;
  if (memberTenantId !== tenantId) return false;

  const base = () => supabase
    .from('booking')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('event_id', eventId)
    .eq('status', 'confirmed');

  const { count: asBooker, error: bookerErr } = await base().eq('member_id', member.id);
  if (bookerErr) throw new Error(`booking check failed: ${bookerErr.message}`);
  if ((asBooker || 0) > 0) return true;

  const pattern = emailExactIlikePattern(member.email);
  if (!pattern) return false;
  const { count: asAttendee, error: attendeeErr } = await base().ilike('attendee_email', pattern);
  if (attendeeErr) throw new Error(`attendee booking check failed: ${attendeeErr.message}`);
  return (asAttendee || 0) > 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  const { event_id } = req.query;
  if (!event_id) return res.status(400).json({ error: 'event_id is required' });

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { data: event, error: eventError } = await supabase
      .from('event')
      .select('id, tenant_id, status, is_training')
      .eq('id', event_id)
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc', 'draft'])
      .is('member_group_id', null)
      .single();
    if (eventError || !event || !event.is_training) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const { data: lines, error: linesError } = await supabase
      .from('event_agenda_item')
      .select('id, start_date, start_time, end_date, end_time, description, item_type, location, zoom_webinar_id, zoom_meeting_id, lms_url, speaker_ids, sponsor_ids, sort_order')
      .eq('event_id', event_id)
      .eq('tenant_id', tenant.id)
      .order('start_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: true })
      .order('sort_order', { ascending: true });
    if (linesError) {
      console.error('[PublicEventAgenda] query error:', linesError);
      return res.status(500).json({ error: 'Failed to list agenda' });
    }

    // Entitlement to Zoom/LMS links: confirmed booking as booker or attendee.
    // Failures resolve to "not entitled" rather than breaking the agenda.
    let entitled = false;
    try {
      const member = await getSessionMember(req);
      entitled = await viewerHasConfirmedBooking(event_id, tenant.id, member);
    } catch (entitleErr) {
      console.error('[PublicEventAgenda] entitlement check failed:', entitleErr?.message || entitleErr);
      entitled = false;
    }

    const joinByWebinar = {};
    const joinByMeeting = {};
    if (entitled) {
      const webinarIds = [...new Set((lines || []).map((l) => l.zoom_webinar_id).filter(Boolean))];
      const meetingIds = [...new Set((lines || []).map((l) => l.zoom_meeting_id).filter(Boolean))];
      if (webinarIds.length > 0) {
        const { data } = await supabase.from('zoom_webinar').select('id, join_url, topic, start_time').in('id', webinarIds).eq('tenant_id', tenant.id);
        for (const w of data || []) joinByWebinar[w.id] = w;
      }
      if (meetingIds.length > 0) {
        const { data } = await supabase.from('zoom_meeting').select('id, join_url, topic, start_time').in('id', meetingIds).eq('tenant_id', tenant.id);
        for (const m of data || []) joinByMeeting[m.id] = m;
      }
    }

    // Per-line sponsors resolved server-side (they may not have an
    // event-level assignment, so the public event-sponsors payload can't be
    // relied on to contain them).
    const sponsorIds = [...new Set((lines || []).flatMap((l) => Array.isArray(l.sponsor_ids) ? l.sponsor_ids : []).filter(Boolean))];
    const sponsorById = {};
    if (sponsorIds.length > 0) {
      const { data: sponsorRows } = await supabase
        .from('event_sponsor')
        .select('id, name, logo_url, website_url')
        .in('id', sponsorIds)
        .eq('tenant_id', tenant.id);
      for (const s of sponsorRows || []) sponsorById[s.id] = s;
    }

    const result = (lines || []).map((l) => {
      const z = entitled
        ? ((l.zoom_webinar_id && joinByWebinar[l.zoom_webinar_id]) ||
           (l.zoom_meeting_id && joinByMeeting[l.zoom_meeting_id]) || null)
        : null;
      return {
        id: l.id,
        start_date: l.start_date,
        start_time: l.start_time || null,
        end_date: l.end_date,
        end_time: l.end_time || null,
        description: l.description,
        item_type: l.item_type,
        location: l.location,
        lms_url: entitled ? l.lms_url : null,
        sort_order: l.sort_order,
        zoom_join_url: z?.join_url || null,
        zoom_topic: z?.topic || null,
        speaker_ids: Array.isArray(l.speaker_ids) ? l.speaker_ids.filter(Boolean) : [],
        sponsors: (Array.isArray(l.sponsor_ids) ? l.sponsor_ids : [])
          .map((id) => sponsorById[id])
          .filter(Boolean),
      };
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('[PublicEventAgenda] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
