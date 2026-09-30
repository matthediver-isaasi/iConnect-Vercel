import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';

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

  const sessionMember = await getSessionMember(req);
  if (!sessionMember) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const memberId = sessionMember.id;
  const tenantId = sessionMember.tenant_id;

  if (!memberId || !tenantId) {
    return res.status(400).json({ error: 'Member context required' });
  }

  try {
    const memberEmail = sessionMember.email?.toLowerCase();

    let bookingsQuery = supabase
      .from('complex_event_booking')
      .select('*')
      .eq('tenant_id', tenantId);

    if (memberEmail) {
      bookingsQuery = bookingsQuery.or(`member_id.eq.${memberId},attendee_email.ilike.${memberEmail}`);
    } else {
      bookingsQuery = bookingsQuery.eq('member_id', memberId);
    }

    const { data: bookings, error: bookingsError } = await bookingsQuery
      .order('created_at', { ascending: false });

    if (bookingsError) {
      console.error('[ComplexEventBookings] Error fetching bookings:', bookingsError);
      return res.status(500).json({ error: 'Failed to fetch bookings' });
    }

    if (!bookings || bookings.length === 0) {
      return res.json({ bookings: [], events: {}, sessions: {} });
    }

    const eventIds = [...new Set(bookings.map(b => b.event_id).filter(Boolean))];

    let eventsMap = {};
    if (eventIds.length > 0) {
      const { data: events, error: eventsError } = await supabase
        .from('complex_event')
        .select('id, title, slug, description, summary, image_url, start_date, end_date, location, status, program_tag')
        .in('id', eventIds)
        .eq('tenant_id', tenantId);

      if (eventsError) {
        console.error('[ComplexEventBookings] Error fetching events:', eventsError);
      } else {
        eventsMap = (events || []).reduce((acc, e) => { acc[e.id] = e; return acc; }, {});
      }
    }

    let allSessionsByEvent = {};
    if (eventIds.length > 0) {
      const { data: sessions, error: sessionsError } = await supabase
        .from('complex_event_session')
        .select('id, event_id, complex_event_track_id, title, start_time, end_time, track_name, delivery_mode, location')
        .in('event_id', eventIds)
        .eq('tenant_id', tenantId)
        .order('start_time', { ascending: true });

      if (sessionsError) {
        console.error('[ComplexEventBookings] Error fetching sessions:', sessionsError);
      } else {
        for (const s of (sessions || [])) {
          if (!allSessionsByEvent[s.event_id]) allSessionsByEvent[s.event_id] = [];
          allSessionsByEvent[s.event_id].push(s);
        }
      }
    }

    const ticketClassIds = [...new Set(bookings.map(b => b.ticket_class_id).filter(Boolean))];
    let ticketClassesMap = {};
    if (ticketClassIds.length > 0) {
      const { data: ticketClasses, error: tcError } = await supabase
        .from('complex_event_ticket_class')
        .select('id, linked_track_ids, all_tracks')
        .in('id', ticketClassIds)
        .eq('tenant_id', tenantId);

      if (!tcError && ticketClasses) {
        ticketClassesMap = ticketClasses.reduce((acc, tc) => { acc[tc.id] = tc; return acc; }, {});
      }
    }

    const bookingSessionsMap = {};
    for (const b of bookings) {
      const eventSessions = allSessionsByEvent[b.event_id] || [];
      const tc = b.ticket_class_id ? ticketClassesMap[b.ticket_class_id] : null;

      if (!tc || tc.all_tracks) {
        bookingSessionsMap[b.id] = eventSessions;
      } else {
        const linkedIds = Array.isArray(tc.linked_track_ids) ? tc.linked_track_ids : [];
        if (linkedIds.length === 0) {
          bookingSessionsMap[b.id] = eventSessions;
        } else {
          bookingSessionsMap[b.id] = eventSessions.filter(s =>
            linkedIds.includes(s.complex_event_track_id)
          );
        }
      }
    }

    return res.json({
      bookings,
      events: eventsMap,
      sessions: bookingSessionsMap,
    });
  } catch (err) {
    console.error('[ComplexEventBookings] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
