import { supabase } from '../_lib/database.js';
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
      .select('id, tenant_id, status')
      .eq('id', event_id)
      .eq('tenant_id', tenant.id)
      .in('status', ['published', 'tbc'])
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

    const trackMap = {};
    for (const track of (tracks || [])) {
      trackMap[track.id] = track;
    }
    const trackIds = Object.keys(trackMap);

    const sessionFields = 'id, complex_event_track_id, title, description, image_url, speaker_names, start_time, end_time, location, is_online, display_order';

    let sessionQuery = supabase
      .from('complex_event_session')
      .select(sessionFields)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true })
      .order('start_time', { ascending: true });

    if (trackIds.length > 0) {
      sessionQuery = sessionQuery.in('complex_event_track_id', trackIds);
    } else {
      return res.json([]);
    }

    const { data, error } = await sessionQuery;

    if (error) {
      console.error('[Sessions] Public list error:', error);
      return res.status(500).json({ error: 'Failed to list sessions' });
    }

    const sessions = (data || []).map(session => {
      const track = trackMap[session.complex_event_track_id];
      return {
        ...session,
        track_name: track?.name || null,
        track_colour: track?.colour || null
      };
    });

    return res.json(sessions);
  } catch (error) {
    console.error('[Sessions] Public list error:', error);
    return res.status(500).json({ error: error.message || 'Failed to list sessions' });
  }
}
