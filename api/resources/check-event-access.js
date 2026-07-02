import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionResult = await getSession(req);
  if (!sessionResult?.data) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = sessionResult.data;
  if (!session.tenantId || !session.memberId) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const { linked_events } = req.body || {};

  if (!Array.isArray(linked_events) || linked_events.length === 0) {
    return res.json({ accessible_event_ids: [], accessible_session_ids: [] });
  }

  const validEntries = linked_events.filter(le => le && typeof le.event_id === 'string' && le.event_id.length > 0);
  if (validEntries.length === 0) {
    return res.json({ accessible_event_ids: [], accessible_session_ids: [] });
  }

  try {
    const eventIds = [...new Set(validEntries.map(le => le.event_id))];
    const sessionEntries = validEntries.filter(le => le.session_id && typeof le.session_id === 'string');

    const accessibleEventIds = new Set();
    const accessibleSessionIds = new Set();

    const { data: member } = await supabase
      .from('member')
      .select('id, email')
      .eq('id', session.memberId)
      .eq('tenant_id', session.tenantId)
      .single();

    if (!member) {
      return res.json({ accessible_event_ids: [], accessible_session_ids: [] });
    }

    // Match bookings owned by this member OR where the member's email is the
    // attendee email — covers attendees added to a colleague's group booking
    // (the row is owned by the booker's member_id, not the attendee's).
    let standardBookingsQuery = supabase
      .from('booking')
      .select('event_id')
      .eq('tenant_id', session.tenantId)
      .eq('status', 'confirmed')
      .in('event_id', eventIds);

    standardBookingsQuery = member.email
      ? standardBookingsQuery.or(`member_id.eq.${member.id},attendee_email.ilike.${member.email}`)
      : standardBookingsQuery.eq('member_id', member.id);

    const { data: standardBookings } = await standardBookingsQuery;

    if (standardBookings) {
      standardBookings.forEach(b => accessibleEventIds.add(b.event_id));
    }

    const { data: complexBookings } = await supabase
      .from('complex_event_booking')
      .select('event_id, ticket_class_id')
      .eq('tenant_id', session.tenantId)
      .eq('status', 'confirmed')
      .in('event_id', eventIds)
      .or(`member_id.eq.${member.id},attendee_email.ilike.${member.email}`);

    if (complexBookings) {
      complexBookings.forEach(b => accessibleEventIds.add(b.event_id));
    }

    if (sessionEntries.length > 0 && complexBookings && complexBookings.length > 0) {
      const ticketClassIds = [...new Set(complexBookings.map(b => b.ticket_class_id).filter(Boolean))];
      const sessionIds = [...new Set(sessionEntries.map(se => se.session_id))];

      if (ticketClassIds.length > 0 && sessionIds.length > 0) {
        const { data: ticketClasses } = await supabase
          .from('complex_event_ticket_class')
          .select('id, complex_event_id, linked_track_ids, all_tracks')
          .eq('tenant_id', session.tenantId)
          .in('id', ticketClassIds);

        const { data: sessionTracks } = await supabase
          .from('complex_event_session_track')
          .select('complex_event_session_id, complex_event_track_id')
          .eq('tenant_id', session.tenantId)
          .in('complex_event_session_id', sessionIds);

        if (ticketClasses && sessionTracks) {
          const bookingsByEvent = {};
          complexBookings.forEach(b => {
            if (!bookingsByEvent[b.event_id]) bookingsByEvent[b.event_id] = [];
            bookingsByEvent[b.event_id].push(b);
          });

          for (const entry of sessionEntries) {
            const eventBookings = bookingsByEvent[entry.event_id] || [];
            if (eventBookings.length === 0) continue;

            const sessionTrackIds = sessionTracks
              .filter(st => st.complex_event_session_id === entry.session_id)
              .map(st => st.complex_event_track_id);

            if (sessionTrackIds.length === 0) {
              if (eventBookings.length > 0) {
                accessibleSessionIds.add(entry.session_id);
              }
              continue;
            }

            for (const booking of eventBookings) {
              if (!booking.ticket_class_id) {
                accessibleSessionIds.add(entry.session_id);
                break;
              }

              const tc = ticketClasses.find(t => t.id === booking.ticket_class_id);
              if (!tc) continue;

              if (tc.all_tracks) {
                accessibleSessionIds.add(entry.session_id);
                break;
              }

              const linkedTrackIds = tc.linked_track_ids || [];
              const hasTrackAccess = sessionTrackIds.some(trackId => linkedTrackIds.includes(trackId));
              if (hasTrackAccess) {
                accessibleSessionIds.add(entry.session_id);
                break;
              }
            }
          }
        }
      }
    }

    return res.json({
      accessible_event_ids: [...accessibleEventIds],
      accessible_session_ids: [...accessibleSessionIds]
    });
  } catch (error) {
    console.error('[check-event-access] Error:', error);
    return res.status(500).json({ error: 'Failed to check event access' });
  }
}
