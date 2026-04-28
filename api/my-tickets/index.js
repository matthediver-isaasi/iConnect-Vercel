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

  const tenantId = sessionMember.tenant_id;
  const memberEmail = (sessionMember.email || '').toLowerCase().trim();

  if (!tenantId || !memberEmail) {
    return res.status(400).json({ error: 'Member context required' });
  }

  try {
    const [regularResult, complexResult] = await Promise.all([
      supabase
        .from('booking')
        .select('*')
        .eq('tenant_id', tenantId)
        .ilike('attendee_email', memberEmail),
      supabase
        .from('complex_event_booking')
        .select('*')
        .eq('tenant_id', tenantId)
        .ilike('attendee_email', memberEmail)
        .order('created_at', { ascending: false }),
    ]);

    if (regularResult.error) {
      console.error('[MyTickets] Error fetching regular bookings:', regularResult.error);
      return res.status(500).json({ error: 'Failed to fetch tickets' });
    }
    if (complexResult.error) {
      console.error('[MyTickets] Error fetching complex bookings:', complexResult.error);
      return res.status(500).json({ error: 'Failed to fetch tickets' });
    }

    const bookings = regularResult.data || [];
    const complexBookings = complexResult.data || [];

    // Resolve regular booking event titles/dates and bookers (member_id).
    // Booker member IDs come from both regular and complex bookings so the
    // "Booked by" label works for both ticket types.
    const regularEventIds = [...new Set(bookings.map(b => b.event_id).filter(Boolean))];
    const complexEventIds = [...new Set(complexBookings.map(b => b.event_id).filter(Boolean))];
    const bookerMemberIds = [...new Set([
      ...bookings.map(b => b.member_id).filter(Boolean),
      ...complexBookings.map(b => b.member_id).filter(Boolean),
    ])];

    const [eventsRes, membersRes, complexEventsRes] = await Promise.all([
      regularEventIds.length > 0
        ? supabase
            .from('event')
            .select('*')
            .in('id', regularEventIds)
            .eq('tenant_id', tenantId)
        : Promise.resolve({ data: [], error: null }),
      bookerMemberIds.length > 0
        ? supabase
            .from('member')
            .select('id, first_name, last_name, email')
            .in('id', bookerMemberIds)
        : Promise.resolve({ data: [], error: null }),
      complexEventIds.length > 0
        ? supabase
            .from('complex_event')
            .select('id, title, slug, description, summary, image_url, start_date, end_date, location, status, program_tag')
            .in('id', complexEventIds)
            .eq('tenant_id', tenantId)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (eventsRes.error) {
      console.error('[MyTickets] Error fetching events:', eventsRes.error);
    }
    if (membersRes.error) {
      console.error('[MyTickets] Error fetching booker members:', membersRes.error);
    }
    if (complexEventsRes.error) {
      console.error('[MyTickets] Error fetching complex events:', complexEventsRes.error);
    }

    const events = eventsRes.data || [];
    const members = membersRes.data || [];
    const complexEvents = (complexEventsRes.data || []).reduce((acc, e) => {
      acc[e.id] = e;
      return acc;
    }, {});

    // Sessions for complex events (mirrors /api/complex-event-bookings logic)
    let allSessionsByEvent = {};
    if (complexEventIds.length > 0) {
      const { data: sessions, error: sessionsError } = await supabase
        .from('complex_event_session')
        .select('id, event_id, complex_event_track_id, title, start_time, end_time, track_name, delivery_mode, location')
        .in('event_id', complexEventIds)
        .eq('tenant_id', tenantId)
        .order('start_time', { ascending: true });

      if (sessionsError) {
        console.error('[MyTickets] Error fetching complex sessions:', sessionsError);
      } else {
        for (const s of (sessions || [])) {
          if (!allSessionsByEvent[s.event_id]) allSessionsByEvent[s.event_id] = [];
          allSessionsByEvent[s.event_id].push(s);
        }
      }
    }

    const ticketClassIds = [...new Set(complexBookings.map(b => b.ticket_class_id).filter(Boolean))];
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

    const complexSessionsByBooking = {};
    for (const b of complexBookings) {
      const eventSessions = allSessionsByEvent[b.event_id] || [];
      const tc = b.ticket_class_id ? ticketClassesMap[b.ticket_class_id] : null;

      if (!tc || tc.all_tracks) {
        complexSessionsByBooking[b.id] = eventSessions;
      } else {
        const linkedIds = Array.isArray(tc.linked_track_ids) ? tc.linked_track_ids : [];
        if (linkedIds.length === 0) {
          complexSessionsByBooking[b.id] = eventSessions;
        } else {
          complexSessionsByBooking[b.id] = eventSessions.filter(s =>
            linkedIds.includes(s.complex_event_track_id)
          );
        }
      }
    }

    return res.json({
      bookings,
      events,
      members,
      complexBookings,
      complexEvents,
      complexSessions: complexSessionsByBooking,
    });
  } catch (err) {
    console.error('[MyTickets] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
