// Public agenda lines for a Training event (Task #3419).
// Mirrors /api/complex-event-sessions/public: tenant-resolved, id-scoped,
// returns per-line type/dates/description plus the visible detail (location,
// join link for Online lines — same exposure model as complex session join
// links — and LMS URL for Self study lines).

import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

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
      .select('id, start_date, end_date, description, item_type, location, zoom_webinar_id, zoom_meeting_id, lms_url, sort_order')
      .eq('event_id', event_id)
      .eq('tenant_id', tenant.id)
      .order('sort_order', { ascending: true });
    if (linesError) {
      console.error('[PublicEventAgenda] query error:', linesError);
      return res.status(500).json({ error: 'Failed to list agenda' });
    }

    const webinarIds = [...new Set((lines || []).map((l) => l.zoom_webinar_id).filter(Boolean))];
    const meetingIds = [...new Set((lines || []).map((l) => l.zoom_meeting_id).filter(Boolean))];
    const joinByWebinar = {};
    const joinByMeeting = {};
    if (webinarIds.length > 0) {
      const { data } = await supabase.from('zoom_webinar').select('id, join_url, topic, start_time').in('id', webinarIds);
      for (const w of data || []) joinByWebinar[w.id] = w;
    }
    if (meetingIds.length > 0) {
      const { data } = await supabase.from('zoom_meeting').select('id, join_url, topic, start_time').in('id', meetingIds);
      for (const m of data || []) joinByMeeting[m.id] = m;
    }

    const result = (lines || []).map((l) => {
      const z = (l.zoom_webinar_id && joinByWebinar[l.zoom_webinar_id]) ||
        (l.zoom_meeting_id && joinByMeeting[l.zoom_meeting_id]) || null;
      return {
        id: l.id,
        start_date: l.start_date,
        end_date: l.end_date,
        description: l.description,
        item_type: l.item_type,
        location: l.location,
        lms_url: l.lms_url,
        sort_order: l.sort_order,
        zoom_join_url: z?.join_url || null,
        zoom_topic: z?.topic || null,
      };
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('[PublicEventAgenda] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
