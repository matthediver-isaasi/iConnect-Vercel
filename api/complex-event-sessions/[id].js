import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getZoomAccessTokenForTenant } from '../_lib/zoomClient.js';
import { fromZonedTime } from 'date-fns-tz';

// Converts a datetime-local string (e.g. "2025-06-15T10:00") representing a time
// in the given event timezone to a UTC ISO string for database storage.
// If the input already contains a timezone offset (Z or +/-HH:MM), it is parsed
// directly as UTC without double-converting through fromZonedTime.
function convertLocalTimeToUTC(localTimeStr, timezone) {
  if (/Z$|[+-]\d{2}(:\d{2})?$/.test(localTimeStr)) {
    return new Date(localTimeStr).toISOString();
  }
  const utcDate = fromZonedTime(localTimeStr, timezone);
  return utcDate.toISOString();
}

async function autoProvisionZoom(tenantId, sessionData, rawStartTime, rawEndTime, timezone) {
  const tz = timezone || 'Europe/London';
  const userId = sessionData.zoom_host_id;
  const isWebinar = sessionData.zoom_type === 'webinar';
  const durationMinutes = rawStartTime && rawEndTime
    ? Math.round((new Date(rawEndTime) - new Date(rawStartTime)) / 60000)
    : 60;

  const token = await getZoomAccessTokenForTenant(tenantId);
  const endpoint = isWebinar
    ? `https://api.zoom.us/v2/users/${userId}/webinars`
    : `https://api.zoom.us/v2/users/${userId}/meetings`;

  const payload = {
    topic: sessionData.title,
    type: isWebinar ? 5 : 2,
    start_time: rawStartTime,
    duration: durationMinutes,
    timezone: tz,
    agenda: sessionData.description || '',
    settings: isWebinar
      ? {
          host_video: true,
          panelists_video: true,
          approval_type: sessionData.zoom_registration_required ? 0 : 2,
          registration_type: sessionData.zoom_registration_required ? 1 : undefined,
          audio: 'both',
          auto_recording: 'cloud',
        }
      : {
          host_video: true,
          participant_video: true,
          join_before_host: false,
          mute_upon_entry: true,
          waiting_room: true,
          audio: 'both',
          auto_recording: 'cloud',
        }
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Zoom ${isWebinar ? 'webinar' : 'meeting'} creation failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  if (isWebinar) {
    return {
      zoom_webinar_id: String(data.id),
      zoom_join_url: data.join_url,
      zoom_start_url: data.start_url,
      zoom_registration_url: data.registration_url || null,
    };
  } else {
    return {
      zoom_meeting_id: String(data.id),
      zoom_join_url: data.join_url,
      zoom_start_url: data.start_url,
    };
  }
}

async function cleanupOrphanedZoom(tenantId, zoomResult) {
  try {
    const token = await getZoomAccessTokenForTenant(tenantId);
    const zoomId = zoomResult.zoom_meeting_id || zoomResult.zoom_webinar_id;
    const type = zoomResult.zoom_webinar_id ? 'webinars' : 'meetings';
    await fetch(`https://api.zoom.us/v2/${type}/${zoomId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log(`[Sessions] Cleaned up orphaned Zoom ${type} ${zoomId}`);
  } catch (cleanupErr) {
    console.error('[Sessions] Failed to cleanup orphaned Zoom resource:', cleanupErr.message);
  }
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

  const SESSION_FIELDS = 'id, complex_event_id, tenant_id, title, description, image_url, image_focal_point, speaker_names, speaker_ids, start_time, end_time, location, is_online, display_order, created_at, updated_at, zoom_type, zoom_host_id, zoom_host_email, zoom_meeting_id, zoom_webinar_id, zoom_join_url, zoom_start_url, zoom_registration_url, zoom_registration_required, zoom_link_mode, auto_create_zoom';

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

      const skipOverlapCheck = req.query.skipOverlapCheck === 'true';

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
        if (!skipOverlapCheck && effectiveStart && effectiveEnd) {
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
      } else if (!skipOverlapCheck && (body.start_time || body.end_time)) {
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
        'is_online', 'speaker_names', 'speaker_ids', 'image_url', 'image_focal_point', 'complex_event_id',
        'zoom_type', 'zoom_host_id', 'zoom_host_email', 'zoom_meeting_id', 'zoom_webinar_id',
        'zoom_join_url', 'zoom_start_url', 'zoom_registration_url',
        'zoom_registration_required', 'zoom_link_mode', 'auto_create_zoom'
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

      let finalSession = { ...session, track_ids };
      let zoomProvisioningError = null;

      if (session.auto_create_zoom && session.is_online && session.zoom_host_id && !session.zoom_meeting_id && !session.zoom_webinar_id) {
        const tz2 = body.timezone || 'Europe/London';
        const rawStart = body.start_time || session.start_time;
        const rawEnd = body.end_time || session.end_time;
        const startIsUtc = !body.start_time && session.start_time;
        if (startIsUtc) {
          console.log('[Sessions] PATCH auto-provision: using DB UTC start_time directly (no local time available from request body)');
        }
        try {
          const zoomResult = await autoProvisionZoom(tenantId, session, rawStart, rawEnd, startIsUtc ? 'UTC' : tz2);
          const { error: zoomUpdateError } = await supabase
            .from('complex_event_session')
            .update(zoomResult)
            .eq('id', session.id)
            .eq('tenant_id', tenantId);
          if (zoomUpdateError) {
            console.error('[Sessions] Failed to save Zoom data:', zoomUpdateError);
            await cleanupOrphanedZoom(tenantId, zoomResult);
            zoomProvisioningError = 'Zoom resource created but failed to save to database. Resource was cleaned up.';
          } else {
            finalSession = { ...finalSession, ...zoomResult };
            console.log(`[Sessions] Auto-provisioned Zoom for session "${session.title}":`, zoomResult);
          }
        } catch (zoomErr) {
          console.error('[Sessions] Zoom auto-provision error:', zoomErr.message);
          zoomProvisioningError = zoomErr.message;
        }
      }

      return res.json({ ...finalSession, ...(zoomProvisioningError ? { zoom_provisioning_error: zoomProvisioningError } : {}) });
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
