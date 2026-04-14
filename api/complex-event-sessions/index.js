import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getZoomAccessTokenForTenant } from '../_lib/zoomClient.js';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';

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

function toZoomLocalTime(timeStr, timezone) {
  if (!timeStr) return timeStr;
  const hasOffset = /Z$|[+-]\d{2}(:\d{2})?$/.test(timeStr);
  if (hasOffset) {
    return formatInTimeZone(new Date(timeStr), timezone, "yyyy-MM-dd'T'HH:mm:ss");
  }
  return timeStr.length === 16 ? timeStr + ':00' : timeStr;
}

function computeDuration(startStr, endStr, timezone) {
  if (!startStr || !endStr) return 60;
  const startUtc = fromZonedTime(toZoomLocalTime(startStr, timezone), timezone);
  const endUtc = fromZonedTime(toZoomLocalTime(endStr, timezone), timezone);
  const mins = Math.round((endUtc - startUtc) / 60000);
  return mins > 0 ? mins : 60;
}

async function autoProvisionZoom(tenantId, sessionData, rawStartTime, rawEndTime, timezone) {
  const tz = timezone || 'Europe/London';
  const userId = sessionData.zoom_host_id;
  const isWebinar = sessionData.zoom_type === 'webinar';
  const durationMinutes = computeDuration(rawStartTime, rawEndTime, tz);
  const zoomStartTime = toZoomLocalTime(rawStartTime, tz);

  const token = await getZoomAccessTokenForTenant(tenantId);
  const endpoint = isWebinar
    ? `https://api.zoom.us/v2/users/${userId}/webinars`
    : `https://api.zoom.us/v2/users/${userId}/meetings`;

  const payload = {
    topic: sessionData.title,
    type: isWebinar ? 5 : 2,
    start_time: zoomStartTime,
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

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx?.isAuthenticated || !tenantCtx?.tenantId) {
    return res.status(403).json({ error: 'Authentication required' });
  }
  const tenantId = tenantCtx.tenantId;

  const SESSION_FIELDS = 'id, complex_event_id, tenant_id, title, description, image_url, image_focal_point, speaker_names, speaker_ids, start_time, end_time, location, is_online, display_order, created_at, updated_at, zoom_type, zoom_host_id, zoom_host_email, zoom_meeting_id, zoom_webinar_id, zoom_join_url, zoom_start_url, zoom_registration_url, zoom_registration_required, zoom_link_mode, auto_create_zoom';

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
        speaker_ids,
        is_online = false,
        location,
        image_url,
        image_focal_point,
        track_ids = [],
        complex_event_track_id,
        zoom_type,
        zoom_host_id,
        zoom_host_email,
        zoom_meeting_id,
        zoom_webinar_id,
        zoom_join_url,
        zoom_start_url,
        zoom_registration_url,
        zoom_registration_required,
        zoom_link_mode,
        auto_create_zoom,
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
        image_focal_point: image_focal_point || null,
        speaker_names: speaker_names || null,
        speaker_ids: speaker_ids || null,
        start_time: start_time ? convertLocalTimeToUTC(start_time, timezone) : null,
        end_time: end_time ? convertLocalTimeToUTC(end_time, timezone) : null,
        location: location || null,
        is_online: is_online || false,
        display_order,
      };

      if (zoom_type !== undefined) sessionData.zoom_type = zoom_type;
      if (zoom_host_id !== undefined) sessionData.zoom_host_id = zoom_host_id || null;
      if (zoom_host_email !== undefined) sessionData.zoom_host_email = zoom_host_email || null;
      if (zoom_meeting_id !== undefined) sessionData.zoom_meeting_id = zoom_meeting_id || null;
      if (zoom_webinar_id !== undefined) sessionData.zoom_webinar_id = zoom_webinar_id || null;
      if (zoom_join_url !== undefined) sessionData.zoom_join_url = zoom_join_url || null;
      if (zoom_start_url !== undefined) sessionData.zoom_start_url = zoom_start_url || null;
      if (zoom_registration_url !== undefined) sessionData.zoom_registration_url = zoom_registration_url || null;
      if (zoom_registration_required !== undefined) sessionData.zoom_registration_required = zoom_registration_required;
      if (zoom_link_mode !== undefined) sessionData.zoom_link_mode = zoom_link_mode;
      if (auto_create_zoom !== undefined) sessionData.auto_create_zoom = auto_create_zoom;

      if (complex_event_track_id) {
        sessionData.complex_event_track_id = complex_event_track_id;
      }

      const skipOverlapCheck = req.query.skipOverlapCheck === 'true';
      const preCheckTrackIds = track_ids.length > 0 ? track_ids : (complex_event_track_id ? [complex_event_track_id] : []);
      if (!skipOverlapCheck && preCheckTrackIds.length > 0 && sessionData.start_time && sessionData.end_time) {
        const overlaps = await checkTrackOverlaps(supabase, tenantId, preCheckTrackIds, sessionData.start_time, sessionData.end_time, null);
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
          await supabase.from('complex_event_session').delete().eq('id', session.id);
          return res.status(500).json({ error: 'Failed to assign tracks to session' });
        }
      }

      let finalSession = { ...session, track_ids: effectiveTrackIds };
      let zoomProvisioningError = null;

      if (sessionData.auto_create_zoom && sessionData.is_online && sessionData.zoom_host_id && !sessionData.zoom_meeting_id && !sessionData.zoom_webinar_id) {
        try {
          const zoomResult = await autoProvisionZoom(tenantId, sessionData, start_time, end_time, timezone);
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

      return res.json({ success: true, session: finalSession, ...(zoomProvisioningError ? { zoom_provisioning_error: zoomProvisioningError } : {}) });
    } catch (error) {
      console.error('[Sessions] Create error:', error);
      return res.status(500).json({ error: error.message || 'Failed to create session' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
