import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { fromZonedTime } from 'date-fns-tz';

function convertLocalTimeToUTC(localTimeStr, timezone) {
  const localDate = new Date(localTimeStr);
  const utcDate = fromZonedTime(localDate, timezone);
  return utcDate.toISOString();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser?.tenant_id) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const tenantId = tenantUser.tenant_id;

  const ADMIN_LIST_FIELDS = 'id, complex_event_track_id, tenant_id, title, description, image_url, speaker_names, start_time, end_time, location, is_online, display_order, timezone, delivery_mode, created_at, updated_at';

  if (req.method === 'GET') {
    try {
      const { event_id } = req.query;

      if (!event_id) {
        return res.status(400).json({ error: 'event_id is required' });
      }

      const { data: event, error: eventError } = await supabase
        .from('complex_event')
        .select('id, tenant_id')
        .eq('id', event_id)
        .eq('tenant_id', tenantId)
        .single();

      if (eventError || !event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      const { data: tracks } = await supabase
        .from('complex_event_track')
        .select('id')
        .eq('complex_event_id', event_id)
        .eq('tenant_id', tenantId);

      const trackIds = (tracks || []).map(t => t.id);

      if (trackIds.length === 0) {
        return res.json([]);
      }

      const { data, error } = await supabase
        .from('complex_event_session')
        .select(ADMIN_LIST_FIELDS)
        .in('complex_event_track_id', trackIds)
        .eq('tenant_id', tenantId)
        .order('display_order', { ascending: true })
        .order('start_time', { ascending: true });

      if (error) {
        console.error('[Sessions] List error:', error);
        return res.status(500).json({ error: 'Failed to list sessions' });
      }

      return res.json(data || []);
    } catch (error) {
      console.error('[Sessions] List error:', error);
      return res.status(500).json({ error: error.message || 'Failed to list sessions' });
    }
  }

  if (req.method === 'POST') {
    try {
      const {
        event_id,
        complex_event_track_id,
        title,
        description,
        start_time,
        end_time,
        timezone = 'Europe/London',
        delivery_mode = 'in_person',
        display_order = 0,
        speaker_names,
        is_online = false,
        location,
        image_url
      } = req.body;

      if (!title) {
        return res.status(400).json({ error: 'title is required' });
      }

      let trackId = complex_event_track_id;

      if (event_id && !trackId) {
        const { data: event, error: eventError } = await supabase
          .from('complex_event')
          .select('id, tenant_id')
          .eq('id', event_id)
          .eq('tenant_id', tenantId)
          .single();

        if (eventError || !event) {
          return res.status(404).json({ error: 'Event not found' });
        }

        const { data: tracks } = await supabase
          .from('complex_event_track')
          .select('id')
          .eq('complex_event_id', event_id)
          .eq('tenant_id', tenantId)
          .order('display_order', { ascending: true })
          .limit(1);

        if (!tracks || tracks.length === 0) {
          return res.status(400).json({ error: 'No tracks found for this event. Create a track first.' });
        }
        trackId = tracks[0].id;
      }

      if (!trackId) {
        return res.status(400).json({ error: 'complex_event_track_id or event_id is required' });
      }

      const { data: track, error: trackError } = await supabase
        .from('complex_event_track')
        .select('id, tenant_id, complex_event_id')
        .eq('id', trackId)
        .eq('tenant_id', tenantId)
        .single();

      if (trackError || !track) {
        return res.status(404).json({ error: 'Track not found' });
      }

      const sessionData = {
        complex_event_track_id: trackId,
        tenant_id: tenantId,
        title,
        description: description || null,
        image_url: image_url || null,
        speaker_names: speaker_names || null,
        start_time: start_time ? convertLocalTimeToUTC(start_time, timezone) : null,
        end_time: end_time ? convertLocalTimeToUTC(end_time, timezone) : null,
        location: location || null,
        is_online: is_online || false,
        display_order,
        delivery_mode: delivery_mode || null,
        timezone: timezone || null
      };

      const { data: session, error: insertError } = await supabase
        .from('complex_event_session')
        .insert(sessionData)
        .select(ADMIN_LIST_FIELDS)
        .single();

      if (insertError) {
        console.error('[Sessions] Insert error:', insertError);
        return res.status(500).json({ error: 'Failed to create session' });
      }

      return res.json({ success: true, session });
    } catch (error) {
      console.error('[Sessions] Create error:', error);
      return res.status(500).json({ error: error.message || 'Failed to create session' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

