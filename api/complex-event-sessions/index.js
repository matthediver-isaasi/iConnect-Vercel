import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { fromZonedTime } from 'date-fns-tz';

function convertLocalTimeToUTC(localTimeStr, timezone) {
  const localDate = new Date(localTimeStr);
  const utcDate = fromZonedTime(localDate, timezone);
  return utcDate.toISOString();
}

async function checkTrackOverlaps(supabase, tenantId, eventId, trackIds, startTime, endTime, excludeSessionId) {
  if (!trackIds?.length || !startTime || !endTime) return [];

  const { data: junctions } = await supabase
    .from('complex_event_session_track')
    .select('complex_event_session_id, complex_event_track_id')
    .in('complex_event_track_id', trackIds)
    .eq('tenant_id', tenantId);

  if (!junctions?.length) return [];

  const sessionIds = [...new Set(junctions.map(j => j.complex_event_session_id))].filter(id => id !== excludeSessionId);
  if (!sessionIds.length) return [];

  const { data: sessions } = await supabase
    .from('complex_event_session')
    .select('id, title, start_time, end_time')
    .in('id', sessionIds)
    .eq('tenant_id', tenantId);

  const overlaps = [];
  const newStart = new Date(startTime).getTime();
  const newEnd = new Date(endTime).getTime();

  for (const s of (sessions || [])) {
    if (!s.start_time || !s.end_time) continue;
    const sStart = new Date(s.start_time).getTime();
    const sEnd = new Date(s.end_time).getTime();
    if (newStart < sEnd && newEnd > sStart) {
      const sessionTrackIds = junctions.filter(j => j.complex_event_session_id === s.id).map(j => j.complex_event_track_id);
      const sharedTracks = trackIds.filter(tid => sessionTrackIds.includes(tid));
      if (sharedTracks.length > 0) {
        overlaps.push({ session_id: s.id, title: s.title, shared_track_ids: sharedTracks });
      }
    }
  }
  return overlaps;
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

  const SESSION_FIELDS = 'id, complex_event_id, tenant_id, title, description, image_url, speaker_names, start_time, end_time, location, is_online, display_order, created_at, updated_at';

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

      const { data: sessions, error } = await supabase
        .from('complex_event_session')
        .select(SESSION_FIELDS)
        .eq('complex_event_id', event_id)
        .eq('tenant_id', tenantId)
        .order('display_order', { ascending: true })
        .order('start_time', { ascending: true });

      if (error) {
        console.error('[Sessions] List error:', error);
        return res.status(500).json({ error: 'Failed to list sessions' });
      }

      const sessionIds = (sessions || []).map(s => s.id);
      let junctions = [];
      if (sessionIds.length > 0) {
        const { data: jData } = await supabase
          .from('complex_event_session_track')
          .select('complex_event_session_id, complex_event_track_id')
          .in('complex_event_session_id', sessionIds)
          .eq('tenant_id', tenantId);
        junctions = jData || [];
      }

      const allTrackIds = [...new Set(junctions.map(j => j.complex_event_track_id))];
      let trackMap = {};
      if (allTrackIds.length > 0) {
        const { data: tracks } = await supabase
          .from('complex_event_track')
          .select('id, name, colour')
          .in('id', allTrackIds);
        for (const t of (tracks || [])) {
          trackMap[t.id] = t;
        }
      }

      const sessionTrackMap = {};
      for (const j of junctions) {
        if (!sessionTrackMap[j.complex_event_session_id]) {
          sessionTrackMap[j.complex_event_session_id] = [];
        }
        sessionTrackMap[j.complex_event_session_id].push(j.complex_event_track_id);
      }

      const enriched = (sessions || []).map(s => {
        const tids = sessionTrackMap[s.id] || [];
        return {
          ...s,
          track_ids: tids,
          track_names: tids.map(tid => trackMap[tid]?.name).filter(Boolean),
          track_colours: tids.map(tid => trackMap[tid]?.colour).filter(Boolean),
          complex_event_track_id: tids[0] || null,
        };
      });

      return res.json(enriched);
    } catch (error) {
      console.error('[Sessions] List error:', error);
      return res.status(500).json({ error: error.message || 'Failed to list sessions' });
    }
  }

  if (req.method === 'POST') {
    try {
      const {
        complex_event_id,
        event_id,
        title,
        description,
        start_time,
        end_time,
        timezone = 'Europe/London',
        display_order = 0,
        speaker_names,
        is_online = false,
        location,
        image_url,
        track_ids = [],
        complex_event_track_id,
      } = req.body;

      const effectiveEventId = complex_event_id || event_id;

      if (!title) {
        return res.status(400).json({ error: 'title is required' });
      }

      if (!effectiveEventId) {
        return res.status(400).json({ error: 'complex_event_id is required' });
      }

      const { data: eventCheck, error: eventError } = await supabase
        .from('complex_event')
        .select('id, tenant_id')
        .eq('id', effectiveEventId)
        .eq('tenant_id', tenantId)
        .single();

      if (eventError || !eventCheck) {
        return res.status(404).json({ error: 'Event not found' });
      }

      const sessionData = {
        complex_event_id: effectiveEventId,
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
      };

      if (complex_event_track_id) {
        sessionData.complex_event_track_id = complex_event_track_id;
      }

      const preCheckTrackIds = track_ids.length > 0 ? track_ids : (complex_event_track_id ? [complex_event_track_id] : []);
      if (preCheckTrackIds.length > 0 && sessionData.start_time && sessionData.end_time) {
        const overlaps = await checkTrackOverlaps(supabase, tenantId, effectiveEventId, preCheckTrackIds, sessionData.start_time, sessionData.end_time, null);
        if (overlaps.length > 0) {
          const msgs = overlaps.map(o => `"${o.title}"`).join(', ');
          return res.status(409).json({ error: `Time overlap with: ${msgs}`, overlaps });
        }
      }

      const { data: session, error: insertError } = await supabase
        .from('complex_event_session')
        .insert(sessionData)
        .select(SESSION_FIELDS)
        .single();

      if (insertError) {
        console.error('[Sessions] Insert error:', insertError);
        return res.status(500).json({ error: 'Failed to create session' });
      }

      const effectiveTrackIds = track_ids.length > 0 ? track_ids : (complex_event_track_id ? [complex_event_track_id] : []);

      if (effectiveTrackIds.length > 0) {
        const { data: validTracks } = await supabase
          .from('complex_event_track')
          .select('id')
          .in('id', effectiveTrackIds)
          .eq('complex_event_id', effectiveEventId)
          .eq('tenant_id', tenantId);

        const validTrackIds = (validTracks || []).map(t => t.id);
        const invalidIds = effectiveTrackIds.filter(id => !validTrackIds.includes(id));
        if (invalidIds.length > 0) {
          await supabase.from('complex_event_session').delete().eq('id', session.id);
          return res.status(400).json({ error: `Invalid track IDs: ${invalidIds.join(', ')}` });
        }

        const junctionRows = effectiveTrackIds.map(tid => ({
          complex_event_session_id: session.id,
          complex_event_track_id: tid,
          tenant_id: tenantId,
        }));

        const { error: junctionError } = await supabase
          .from('complex_event_session_track')
          .insert(junctionRows);

        if (junctionError) {
          console.error('[Sessions] Junction insert error:', junctionError);
          return res.status(500).json({ error: 'Failed to assign tracks to session' });
        }
      }

      return res.json({ success: true, session: { ...session, track_ids: effectiveTrackIds } });
    } catch (error) {
      console.error('[Sessions] Create error:', error);
      return res.status(500).json({ error: error.message || 'Failed to create session' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
