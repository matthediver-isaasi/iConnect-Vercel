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
      .select('id, title, slug, description, summary, start_date, end_date, location, image_url, status, timezone, available_seats, event_state, registration_closes_at, event_type, is_featured, cta_override_url, cta_override_mode, cta_button_label, replace_booking_elements, booking_replacement_message, booking_replacement_cta_label, member_group_id, group_event_public, custom_duration_explainer')
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc'])
      .or('event_state.is.null,event_state.eq.active,event_state.eq.closed')
      // Surface ordinary (non-group) events PLUS public group events
      // (group_event_public = true). Group-only complex events are never
      // leaked to anonymous visitors.
      .or('member_group_id.is.null,group_event_public.is.true')
      .order('start_date', { ascending: true });

    if (error) {
      console.error('[Public Complex Events] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch complex events' });
    }

    const eventIds = (rawEvents || []).map(e => e.id);
    const timezoneByEvent = {};
    (rawEvents || []).forEach(e => { timezoneByEvent[e.id] = e.timezone || 'Europe/London'; });

    // Task #3266: bucket each event's sessions by calendar day (in the
    // event's timezone) so cards can show a day count and detect
    // non-consecutive event days.
    const dayKeyFormatters = {};
    const dayKeyForSession = (eventId, startTime) => {
      const tz = timezoneByEvent[eventId] || 'Europe/London';
      if (!dayKeyFormatters[tz]) {
        try {
          dayKeyFormatters[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
        } catch {
          dayKeyFormatters[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
        }
      }
      const d = new Date(startTime);
      if (Number.isNaN(d.getTime())) return null;
      return dayKeyFormatters[tz].format(d); // en-CA => yyyy-mm-dd
    };
    const dayKeysByEvent = {};

    let sessionCountByEvent = {};
    let trackCountByEvent = {};
    if (eventIds.length > 0) {
      const [sessionRes, trackRes] = await Promise.all([
        supabase
          .from('complex_event_session')
          .select('complex_event_id, start_time')
          .in('complex_event_id', eventIds)
          .eq('tenant_id', tenant.id),
        supabase
          .from('complex_event_track')
          .select('complex_event_id')
          .in('complex_event_id', eventIds)
          .eq('tenant_id', tenant.id)
      ]);

      if (sessionRes.error) {
        console.error('[Public Complex Events] Session count query error:', sessionRes.error);
      } else if (sessionRes.data) {
        for (const s of sessionRes.data) {
          sessionCountByEvent[s.complex_event_id] = (sessionCountByEvent[s.complex_event_id] || 0) + 1;
          if (s.start_time) {
            const key = dayKeyForSession(s.complex_event_id, s.start_time);
            if (key) {
              if (!dayKeysByEvent[s.complex_event_id]) dayKeysByEvent[s.complex_event_id] = new Set();
              dayKeysByEvent[s.complex_event_id].add(key);
            }
          }
        }
      }

      if (trackRes.error) {
        console.error('[Public Complex Events] Track count query error:', trackRes.error);
      } else if (trackRes.data) {
        for (const t of trackRes.data) {
          trackCountByEvent[t.complex_event_id] = (trackCountByEvent[t.complex_event_id] || 0) + 1;
        }
      }
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
      const allPrices = allTicketClasses
        .map(tc => Number(tc.price))
        .filter(p => Number.isFinite(p));
      const cheapestPrice = allPrices.length > 0 ? Math.min(...allPrices) : null;
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

      const dayKeys = [...(dayKeysByEvent[event.id] || [])].sort();
      const dayCount = dayKeys.length;
      let daysNonconsecutive = false;
      if (dayCount > 1) {
        const spanDays = Math.round(
          (Date.parse(`${dayKeys[dayCount - 1]}T00:00:00Z`) - Date.parse(`${dayKeys[0]}T00:00:00Z`)) / 86400000
        ) + 1;
        daysNonconsecutive = spanDays > dayCount;
      }

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
        registration_closes_at: event.registration_closes_at || null,
        event_type: event.event_type || null,
        is_featured: event.is_featured || false,
        is_complex: true,
        session_count: sessionCountByEvent[event.id] || 0,
        day_count: dayCount,
        days_nonconsecutive: daysNonconsecutive,
        custom_duration_explainer: event.custom_duration_explainer || null,
        track_count: trackCountByEvent[event.id] || 0,
        cheapest_price: cheapestPrice,
        pricing_config: publicTicketClasses.length > 0 ? { ticket_classes: publicTicketClasses } : null,
        cta_override_url: event.cta_override_url || null,
        cta_override_mode: event.cta_override_mode || 'card',
        cta_button_label: event.cta_button_label || null,
        replace_booking_elements: event.replace_booking_elements === true,
        booking_replacement_message: event.booking_replacement_message || null,
        booking_replacement_cta_label: event.booking_replacement_cta_label || null
      };
    });

    res.json(events);
  } catch (error) {
    console.error('[Public Complex Events] Error:', error);
    res.status(500).json({ error: 'Failed to fetch complex events' });
  }
}
