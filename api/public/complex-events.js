import { createClient } from '@supabase/supabase-js';
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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: rawEvents, error } = await supabase
      .from('complex_event')
      .select('id, title, slug, description, summary, start_date, end_date, location, image_url, status, timezone, available_seats, event_state, event_type')
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc'])
      .or('event_state.is.null,event_state.eq.active,event_state.eq.closed')
      .order('start_date', { ascending: true });

    if (error) {
      console.error('[Public Complex Events] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch complex events' });
    }

    const eventIds = (rawEvents || []).map(e => e.id);

    let sessionCountByEvent = {};
    let trackCountByEvent = {};
    if (eventIds.length > 0) {
      const sessionCountPromises = eventIds.map(id =>
        supabase
          .from('complex_event_session')
          .select('*', { count: 'exact', head: true })
          .eq('complex_event_id', id)
          .eq('tenant_id', tenant.id)
      );
      const trackCountPromises = eventIds.map(id =>
        supabase
          .from('complex_event_track')
          .select('*', { count: 'exact', head: true })
          .eq('complex_event_id', id)
          .eq('tenant_id', tenant.id)
      );

      const [sessionResults, trackResults] = await Promise.all([
        Promise.all(sessionCountPromises),
        Promise.all(trackCountPromises)
      ]);

      eventIds.forEach((id, i) => {
        if (!sessionResults[i].error) {
          sessionCountByEvent[id] = sessionResults[i].count || 0;
        }
        if (!trackResults[i].error) {
          trackCountByEvent[id] = trackResults[i].count || 0;
        }
      });
    }

    let ticketClassesByEvent = {};
    if (eventIds.length > 0) {
      const { data: ticketClasses, error: tcError } = await supabase
        .from('complex_event_ticket_class')
        .select('id, complex_event_id, name, price, is_free, early_bird_enabled, early_bird_price, early_bird_deadline, visibility_mode, linked_track_ids, all_tracks, display_order')
        .in('complex_event_id', eventIds)
        .eq('tenant_id', tenant.id)
        .order('display_order', { ascending: true });

      if (!tcError && ticketClasses) {
        for (const tc of ticketClasses) {
          if (!ticketClassesByEvent[tc.complex_event_id]) {
            ticketClassesByEvent[tc.complex_event_id] = [];
          }
          ticketClassesByEvent[tc.complex_event_id].push(tc);
        }
      }
    }

    const events = (rawEvents || []).map(event => {
      const allTicketClasses = ticketClassesByEvent[event.id] || [];
      const publicTicketClasses = allTicketClasses
        .filter(tc => {
          const vis = tc.visibility_mode || 'members_only';
          return vis === 'members_and_public' || vis === 'public_only';
        })
        .map(tc => ({
          id: tc.id,
          name: tc.name,
          price: Number(tc.price) || 0,
          currency: 'gbp',
          visibility_mode: tc.visibility_mode,
          early_bird_enabled: tc.early_bird_enabled || false,
          early_bird_price: tc.early_bird_price != null ? Number(tc.early_bird_price) : null,
          early_bird_deadline: tc.early_bird_deadline || null,
          linked_track_ids: tc.linked_track_ids || [],
          all_tracks: tc.all_tracks
        }));

      return {
        id: event.id,
        title: event.title,
        slug: event.slug || null,
        description: event.description,
        summary: event.summary,
        start_date: event.start_date,
        end_date: event.end_date,
        location: event.location,
        image_url: event.image_url,
        status: event.status,
        available_seats: event.available_seats,
        timezone: event.timezone,
        event_state: event.event_state || null,
        event_type: event.event_type || null,
        is_complex: true,
        session_count: sessionCountByEvent[event.id] || 0,
        track_count: trackCountByEvent[event.id] || 0,
        pricing_config: publicTicketClasses.length > 0 ? { ticket_classes: publicTicketClasses } : null
      };
    });

    res.json(events);
  } catch (error) {
    console.error('[Public Complex Events] Error:', error);
    res.status(500).json({ error: 'Failed to fetch complex events' });
  }
}
