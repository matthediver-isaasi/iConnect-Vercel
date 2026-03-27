import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const { event_id } = req.query;

  if (!event_id) {
    return res.status(400).json({ error: 'event_id is required' });
  }

  try {
    const baseFields = 'id, event_id, title, description, start_time, end_time, duration_minutes, timezone, delivery_mode, track_name, sort_order, status, zoom_type';

    const { data, error } = await supabase
      .from('complex_event_session')
      .select(baseFields + ', zoom_join_url, zoom_registration_url, zoom_registration_required')
      .eq('event_id', event_id)
      .eq('status', 'scheduled')
      .order('sort_order', { ascending: true })
      .order('start_time', { ascending: true });

    if (error) {
      console.error('[Sessions] Public list error:', error);
      return res.status(500).json({ error: 'Failed to list sessions' });
    }

    let bookedTrackNames = [];
    let hasAnyConfirmedBooking = false;
    try {
      const member = await getSessionMember(req);
      if (member?.email) {
        const { data: bookings } = await supabase
          .from('booking')
          .select('id, ticket_class_name')
          .eq('event_id', event_id)
          .ilike('attendee_email', member.email.toLowerCase())
          .in('status', ['confirmed', 'attended']);

        if (bookings && bookings.length > 0) {
          hasAnyConfirmedBooking = true;
          bookedTrackNames = bookings
            .map(b => (b.ticket_class_name || '').trim().toLowerCase())
            .filter(Boolean);
        }
      }
    } catch (e) {
    }

    const sessions = (data || []).map(session => {
      const { zoom_join_url, zoom_registration_url, zoom_registration_required, ...publicFields } = session;
      const isVirtualSession = session.delivery_mode === 'virtual' || session.delivery_mode === 'hybrid';

      if (!hasAnyConfirmedBooking || !isVirtualSession) {
        return publicFields;
      }

      const sessionTrack = (session.track_name || '').trim().toLowerCase();
      let hasTrackAccess;
      if (!sessionTrack) {
        hasTrackAccess = true;
      } else if (bookedTrackNames.length === 0) {
        hasTrackAccess = false;
      } else {
        hasTrackAccess = bookedTrackNames.includes(sessionTrack);
      }

      if (hasTrackAccess) {
        return { ...publicFields, zoom_join_url, zoom_registration_required };
      }

      return publicFields;
    });

    return res.json(sessions);
  } catch (error) {
    console.error('[Sessions] Public list error:', error);
    return res.status(500).json({ error: error.message || 'Failed to list sessions' });
  }
}
