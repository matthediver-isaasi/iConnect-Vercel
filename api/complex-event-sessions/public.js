import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

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
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: event, error: eventError } = await supabase
      .from('complex_event')
      .select('id, tenant_id')
      .eq('id', event_id)
      .eq('tenant_id', tenant.id)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const { data: tracks, error: tracksError } = await supabase
      .from('complex_event_track')
      .select('id, name, description, colour, display_order')
      .eq('complex_event_id', event_id)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true });

    if (tracksError) {
      console.error('[Sessions] Tracks query error:', tracksError);
      return res.status(500).json({ error: 'Failed to list tracks' });
    }

    const trackIds = (tracks || []).map(t => t.id);

    if (trackIds.length === 0) {
      return res.json([]);
    }

    const trackMap = {};
    for (const track of tracks) {
      trackMap[track.id] = track;
    }

    const sessionFields = 'id, complex_event_track_id, title, description, image_url, speaker_names, start_time, end_time, location, is_online, display_order, zoom_join_url, zoom_registration_url, zoom_registration_required, delivery_mode, zoom_type';

    const { data, error } = await supabase
      .from('complex_event_session')
      .select(sessionFields)
      .in('complex_event_track_id', trackIds)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true })
      .order('start_time', { ascending: true });

    if (error) {
      console.error('[Sessions] Public list error:', error);
      return res.status(500).json({ error: 'Failed to list sessions' });
    }

    let bookedTrackIds = [];
    let hasAnyConfirmedBooking = false;
    try {
      const member = await getSessionMember(req);
      if (member?.email) {
        const { data: bookings } = await supabase
          .from('complex_event_booking')
          .select('id, ticket_class_id')
          .eq('event_id', event_id)
          .eq('tenant_id', tenant.id)
          .ilike('attendee_email', member.email.toLowerCase())
          .in('status', ['confirmed', 'attended']);

        if (bookings && bookings.length > 0) {
          hasAnyConfirmedBooking = true;
          const ticketClassIds = bookings
            .map(b => b.ticket_class_id)
            .filter(Boolean);

          if (ticketClassIds.length > 0) {
            const { data: ticketClasses } = await supabase
              .from('complex_event_ticket_class')
              .select('id, linked_track_ids, all_tracks')
              .in('id', ticketClassIds)
              .eq('tenant_id', tenant.id);

            if (ticketClasses) {
              for (const tc of ticketClasses) {
                if (tc.all_tracks) {
                  bookedTrackIds = trackIds;
                  break;
                }
                if (tc.linked_track_ids && Array.isArray(tc.linked_track_ids)) {
                  bookedTrackIds.push(...tc.linked_track_ids);
                }
              }
              bookedTrackIds = [...new Set(bookedTrackIds)];
            }
          }
        }
      }
    } catch (e) {
    }

    const sessions = (data || []).map(session => {
      const { zoom_join_url, zoom_registration_url, zoom_registration_required, ...publicFields } = session;
      const track = trackMap[session.complex_event_track_id];
      const enriched = {
        ...publicFields,
        track_name: track?.name || null,
        track_colour: track?.colour || null
      };

      const isVirtualSession = session.delivery_mode === 'virtual' || session.delivery_mode === 'hybrid' || session.is_online;

      if (!hasAnyConfirmedBooking || !isVirtualSession) {
        return enriched;
      }

      const hasTrackAccess = bookedTrackIds.includes(session.complex_event_track_id);

      if (hasTrackAccess) {
        return { ...enriched, zoom_join_url, zoom_registration_required };
      }

      return enriched;
    });

    return res.json(sessions);
  } catch (error) {
    console.error('[Sessions] Public list error:', error);
    return res.status(500).json({ error: error.message || 'Failed to list sessions' });
  }
}
