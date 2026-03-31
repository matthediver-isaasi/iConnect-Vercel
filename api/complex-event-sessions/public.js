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

    const { data: sessions, error: sessionsError } = await supabase
      .from('complex_event_session')
      .select('id, title, description, image_url, image_focal_point, speaker_names, speaker_ids, start_time, end_time, location, is_online, display_order, complex_event_id')
      .eq('complex_event_id', event_id)
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true })
      .order('start_time', { ascending: true });

    if (sessionsError) {
      console.error('[Sessions] Public list error:', sessionsError);
      return res.status(500).json({ error: 'Failed to list sessions' });
    }

    if (!sessions || sessions.length === 0) {
      return res.json([]);
    }

    const sessionIds = sessions.map(s => s.id);
    const { data: junctions, error: junctionError } = await supabase
      .from('complex_event_session_track')
      .select('complex_event_session_id, complex_event_track_id')
      .in('complex_event_session_id', sessionIds)
      .eq('tenant_id', tenant.id);

    if (junctionError) {
      console.error('[Sessions] Junction query error:', junctionError);
    }

    const sessionTrackMap = {};
    for (const j of (junctions || [])) {
      if (!sessionTrackMap[j.complex_event_session_id]) {
        sessionTrackMap[j.complex_event_session_id] = [];
      }
      sessionTrackMap[j.complex_event_session_id].push(j.complex_event_track_id);
    }

    const enriched = sessions.map(session => {
      const trackIds = sessionTrackMap[session.id] || [];
      const trackNames = trackIds.map(tid => trackMap[tid]?.name).filter(Boolean);
      const trackColours = trackIds.map(tid => trackMap[tid]?.colour).filter(Boolean);
      return {
        ...session,
        track_ids: trackIds,
        track_names: trackNames,
        track_colours: trackColours,
        track_name: trackNames[0] || null,
        track_colour: trackColours[0] || null,
      };
    });

    return res.json(enriched);
  } catch (error) {
    console.error('[Sessions] Public list error:', error);
    return res.status(500).json({ error: error.message || 'Failed to list sessions' });
  }
}
