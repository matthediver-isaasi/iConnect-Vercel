import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { fromZonedTime } from 'date-fns-tz';

function convertLocalTimeToUTC(localTimeStr, timezone) {
  const localDate = new Date(localTimeStr);
  const utcDate = fromZonedTime(localDate, timezone);
  return utcDate.toISOString();
}

async function checkTrackOverlaps(supabase, tenantId, trackIds, startTime, endTime, excludeSessionId) {
  if (!trackIds?.length || !startTime || !endTime) return [];

  const { data: junctions } = await supabase
    .from('complex_event_session_track')
    .select('complex_event_session_id, complex_event_track_id')
    .in('complex_event_track_id', trackIds)
    .eq('tenant_id', tenantId);

  if (!junctions?.length) return [];

  const sessionIds = [...new Set(junctions.map(j => j.complex_event_session_id))].filter(sid => sid !== excludeSessionId);
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx?.isAuthenticated || !tenantCtx?.tenantId) {
    return res.status(403).json({ error: 'Authentication required' });
  }
  const tenantId = tenantCtx.tenantId;

  const { id } = req.query;

  const SESSION_FIELDS = 'id, complex_event_id, tenant_id, title, description, image_url, speaker_names, speaker_ids, start_time, end_time, location, is_online, display_order, created_at, updated_at';

  if (req.method === 'GET') {
    try {
      const { data: session, error } = await supabase
        .from('complex_event_session')
        .select(SESSION_FIELDS)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Session not found' });
        }
        return res.status(500).json({ error: error.message });
      }

      const { data: junctions } = await supabase
        .from('complex_event_session_track')
        .select('complex_event_track_id')
        .eq('complex_event_session_id', id)
        .eq('tenant_id', tenantId);

      const track_ids = (junctions || []).map(j => j.complex_event_track_id);

      return res.json({ ...session, track_ids });
    } catch (error) {
      console.error('[Sessions] Get error:', error);
      return res.status(500).json({ error: error.message || 'Failed to get session' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const body = req.body;

      const { data: existing, error: fetchError } = await supabase
        .from('complex_event_session')
        .select(SESSION_FIELDS)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (fetchError || !existing) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (body.track_ids && Array.isArray(body.track_ids)) {
        const newTrackIds = body.track_ids;

        if (newTrackIds.length > 0) {
          const sessionEventId = body.complex_event_id || existing.complex_event_id;
          const { data: validTracks } = await supabase
            .from('complex_event_track')
            .select('id')
            .in('id', newTrackIds)
            .eq('tenant_id', tenantId)
            .eq('complex_event_id', sessionEventId);

          const validTrackIds = (validTracks || []).map(t => t.id);
          const invalidIds = newTrackIds.filter(tid => !validTrackIds.includes(tid));
          if (invalidIds.length > 0) {
            return res.status(400).json({ error: `Invalid track IDs: ${invalidIds.join(', ')}` });
          }
        }

        const tz = body.timezone || 'Europe/London';
        const effectiveStart = body.start_time ? convertLocalTimeToUTC(body.start_time, tz) : existing.start_time;
        const effectiveEnd = body.end_time ? convertLocalTimeToUTC(body.end_time, tz) : existing.end_time;
        if (effectiveStart && effectiveEnd) {
          const overlaps = await checkTrackOverlaps(supabase, tenantId, newTrackIds, effectiveStart, effectiveEnd, id);
          if (overlaps.length > 0) {
            const msgs = overlaps.map(o => `"${o.title}"`).join(', ');
            return res.status(409).json({ error: `Time overlap with: ${msgs}`, overlaps });
          }
        }

        const { data: existingJunctions } = await supabase
          .from('complex_event_session_track')
          .select('complex_event_track_id')
          .eq('complex_event_session_id', id)
          .eq('tenant_id', tenantId);

        const existingTrackIds = (existingJunctions || []).map(j => j.complex_event_track_id);

        const toAdd = newTrackIds.filter(tid => !existingTrackIds.includes(tid));
        const toRemove = existingTrackIds.filter(tid => !newTrackIds.includes(tid));

        if (toRemove.length > 0) {
          const { error: removeError } = await supabase
            .from('complex_event_session_track')
            .delete()
            .eq('complex_event_session_id', id)
            .eq('tenant_id', tenantId)
            .in('complex_event_track_id', toRemove);
          if (removeError) {
            console.error('[Sessions] Junction remove error:', removeError);
            return res.status(500).json({ error: 'Failed to update track assignments' });
          }
        }

        if (toAdd.length > 0) {
          const rows = toAdd.map(tid => ({
            complex_event_session_id: id,
            complex_event_track_id: tid,
            tenant_id: tenantId,
          }));
          const { error: insertError } = await supabase
            .from('complex_event_session_track')
            .insert(rows);
          if (insertError) {
            console.error('[Sessions] Junction insert error:', insertError);
            return res.status(500).json({ error: 'Failed to update track assignments' });
          }
        }
      } else if (body.start_time || body.end_time) {
        const { data: currentJunctions } = await supabase
          .from('complex_event_session_track')
          .select('complex_event_track_id')
          .eq('complex_event_session_id', id)
          .eq('tenant_id', tenantId);

        const currentTrackIds = (currentJunctions || []).map(j => j.complex_event_track_id);
        if (currentTrackIds.length > 0) {
          const tz = body.timezone || 'Europe/London';
          const effectiveStart = body.start_time ? convertLocalTimeToUTC(body.start_time, tz) : existing.start_time;
          const effectiveEnd = body.end_time ? convertLocalTimeToUTC(body.end_time, tz) : existing.end_time;
          if (effectiveStart && effectiveEnd) {
            const overlaps = await checkTrackOverlaps(supabase, tenantId, currentTrackIds, effectiveStart, effectiveEnd, id);
            if (overlaps.length > 0) {
              const msgs = overlaps.map(o => `"${o.title}"`).join(', ');
              return res.status(409).json({ error: `Time overlap with: ${msgs}`, overlaps });
            }
          }
        }
      }

      const ALLOWED_FIELDS = [
        'title', 'description', 'start_time', 'end_time',
        'display_order', 'location',
        'is_online', 'speaker_names', 'speaker_ids', 'image_url', 'complex_event_id'
      ];
      const dbUpdates = { updated_at: new Date().toISOString() };
      for (const field of ALLOWED_FIELDS) {
        if (field in body) {
          dbUpdates[field] = body[field];
        }
      }

      const tz = body.timezone || 'Europe/London';
      if (dbUpdates.start_time) {
        dbUpdates.start_time = convertLocalTimeToUTC(dbUpdates.start_time, tz);
      }
      if (dbUpdates.end_time) {
        dbUpdates.end_time = convertLocalTimeToUTC(dbUpdates.end_time, tz);
      }

      const { data: session, error: updateError } = await supabase
        .from('complex_event_session')
        .update(dbUpdates)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select(SESSION_FIELDS)
        .single();

      if (updateError) {
        console.error('[Sessions] Update error:', updateError);
        return res.status(500).json({ error: 'Failed to update session' });
      }

      const { data: updatedJunctions } = await supabase
        .from('complex_event_session_track')
        .select('complex_event_track_id')
        .eq('complex_event_session_id', id)
        .eq('tenant_id', tenantId);

      const track_ids = (updatedJunctions || []).map(j => j.complex_event_track_id);

      return res.json({ ...session, track_ids });
    } catch (error) {
      console.error('[Sessions] Update error:', error);
      return res.status(500).json({ error: error.message || 'Failed to update session' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { data: session, error: fetchError } = await supabase
        .from('complex_event_session')
        .select('id, tenant_id')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (fetchError || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const { error: deleteError } = await supabase
        .from('complex_event_session')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);

      if (deleteError) {
        console.error('[Sessions] Delete error:', deleteError);
        return res.status(500).json({ error: 'Failed to delete session' });
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('[Sessions] Delete error:', error);
      return res.status(500).json({ error: error.message || 'Failed to delete session' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
