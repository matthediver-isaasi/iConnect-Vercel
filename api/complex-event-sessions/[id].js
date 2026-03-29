import { supabase } from '../_lib/database.js';
import { getZoomAccessToken, getZoomAccessTokenForTenant, getTenantIdFromSession } from '../_lib/zoomClient.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { fromZonedTime } from 'date-fns-tz';

function convertLocalTimeToUTC(localTimeStr, timezone) {
  const localDate = new Date(localTimeStr);
  const utcDate = fromZonedTime(localDate, timezone);
  return utcDate.toISOString();
}

async function createZoomForSession({ tenantId, title, description, start_time, duration_minutes, timezone, zoom_type, zoom_host_id, zoom_registration_required }) {
  const token = await getZoomAccessTokenForTenant(tenantId);
  const userId = zoom_host_id || 'me';

  if (zoom_type === 'meeting') {
    const meetingPayload = {
      topic: title,
      type: 2,
      start_time,
      duration: duration_minutes,
      timezone,
      agenda: description || '',
      settings: {
        host_video: true,
        participant_video: true,
        join_before_host: false,
        mute_upon_entry: true,
        waiting_room: true,
        audio: 'both',
        auto_recording: 'cloud'
      }
    };

    const zoomResponse = await fetch(`https://api.zoom.us/v2/users/${userId}/meetings`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(meetingPayload)
    });

    if (!zoomResponse.ok) {
      const errorText = await zoomResponse.text();
      return { error: `Failed to create Zoom meeting: ${errorText}` };
    }

    const zoomData = await zoomResponse.json();
    return {
      data: {
        zoom_meeting_id: String(zoomData.id),
        zoom_join_url: zoomData.join_url,
        zoom_start_url: zoomData.start_url,
        zoom_password: zoomData.password,
        zoom_host_id: zoomData.host_id
      }
    };
  }

  if (zoom_type === 'webinar') {
    const webinarPayload = {
      topic: title,
      type: 5,
      start_time,
      duration: duration_minutes,
      timezone,
      agenda: description || '',
      settings: {
        host_video: true,
        panelists_video: true,
        practice_session: true,
        hd_video: true,
        approval_type: zoom_registration_required ? 0 : 2,
        registration_type: zoom_registration_required ? 1 : undefined,
        audio: 'both',
        auto_recording: 'cloud'
      }
    };

    const zoomResponse = await fetch(`https://api.zoom.us/v2/users/${userId}/webinars`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(webinarPayload)
    });

    if (!zoomResponse.ok) {
      const errorText = await zoomResponse.text();
      return { error: `Failed to create Zoom webinar: ${errorText}` };
    }

    const zoomData = await zoomResponse.json();
    return {
      data: {
        zoom_webinar_id: String(zoomData.id),
        zoom_join_url: zoomData.join_url,
        zoom_start_url: zoomData.start_url,
        zoom_password: zoomData.password,
        zoom_host_id: zoomData.host_id,
        zoom_registration_url: zoomData.registration_url,
        zoom_registration_required
      }
    };
  }

  return { error: 'Invalid zoom_type' };
}

async function linkExistingZoom({ tenantId, zoomId, zoomType }) {
  const token = await getZoomAccessTokenForTenant(tenantId);
  const isWebinar = zoomType === 'webinar';
  const endpoint = isWebinar
    ? `https://api.zoom.us/v2/webinars/${zoomId}`
    : `https://api.zoom.us/v2/meetings/${zoomId}`;

  const zoomResponse = await fetch(endpoint, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!zoomResponse.ok) {
    return { error: `Zoom ${zoomType} not found or not accessible` };
  }

  const zoomData = await zoomResponse.json();
  const result = {
    zoom_join_url: zoomData.join_url,
    zoom_start_url: zoomData.start_url,
    zoom_password: zoomData.password || null,
    zoom_host_id: zoomData.host_id || null,
    zoom_type: zoomType
  };

  if (isWebinar) {
    result.zoom_webinar_id = String(zoomData.id);
    result.zoom_meeting_id = null;
    result.zoom_registration_url = zoomData.registration_url || null;
  } else {
    result.zoom_meeting_id = String(zoomData.id);
    result.zoom_webinar_id = null;
    result.zoom_registration_url = null;
  }

  return { data: result, zoomData };
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

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser?.tenant_id) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const tenantId = tenantUser.tenant_id;

  const { id } = req.query;

  const ADMIN_FIELDS = 'id, complex_event_track_id, tenant_id, title, description, image_url, speaker_names, start_time, end_time, location, is_online, display_order, timezone, delivery_mode, zoom_type, zoom_meeting_id, zoom_webinar_id, zoom_join_url, zoom_start_url, zoom_host_id, zoom_host_email, zoom_registration_required, zoom_registration_url, created_at, updated_at';

  if (req.method === 'GET') {
    try {
      const { data: session, error } = await supabase
        .from('complex_event_session')
        .select(ADMIN_FIELDS)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Session not found' });
        }
        return res.status(500).json({ error: error.message });
      }

      return res.json(session);
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
        .select(ADMIN_FIELDS + ', zoom_password')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (fetchError || !existing) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const ALLOWED_FIELDS = [
        'title', 'description', 'start_time', 'end_time',
        'timezone', 'delivery_mode', 'display_order', 'location',
        'is_online', 'speaker_names', 'image_url', 'complex_event_track_id',
        'zoom_type', 'zoom_host_id', 'zoom_host_email', 'zoom_registration_required'
      ];
      const dbUpdates = { updated_at: new Date().toISOString() };
      for (const field of ALLOWED_FIELDS) {
        if (field in body) {
          dbUpdates[field] = body[field];
        }
      }

      const tz = dbUpdates.timezone || existing.timezone || 'Europe/London';
      if (dbUpdates.start_time) {
        dbUpdates.start_time = convertLocalTimeToUTC(dbUpdates.start_time, tz);
      }
      if (dbUpdates.end_time) {
        dbUpdates.end_time = convertLocalTimeToUTC(dbUpdates.end_time, tz);
      }

      const effectiveDeliveryMode = dbUpdates.delivery_mode || existing.delivery_mode;
      const isVirtual = effectiveDeliveryMode === 'virtual' || effectiveDeliveryMode === 'hybrid';

      if (body.link_existing_zoom_id && isVirtual) {
        const effectiveZoomType = body.link_existing_zoom_type || dbUpdates.zoom_type || existing.zoom_type || 'meeting';
        try {
          const linkResult = await linkExistingZoom({
            tenantId,
            zoomId: body.link_existing_zoom_id,
            zoomType: effectiveZoomType
          });

          if (linkResult.error) {
            return res.status(400).json({ error: linkResult.error });
          }

          Object.assign(dbUpdates, linkResult.data);

          if (!dbUpdates.start_time && !existing.start_time && linkResult.zoomData?.start_time) {
            dbUpdates.start_time = new Date(linkResult.zoomData.start_time).toISOString();
          }
        } catch (linkErr) {
          console.error('[Sessions] Link existing Zoom error:', linkErr);
          return res.status(500).json({ error: 'Failed to link Zoom: ' + linkErr.message });
        }
      } else if (body.auto_create_zoom && isVirtual && !existing.zoom_meeting_id && !existing.zoom_webinar_id) {
        const effectiveZoomType = dbUpdates.zoom_type || existing.zoom_type || 'meeting';
        const effectiveStartTime = dbUpdates.start_time || existing.start_time;
        if (effectiveStartTime) {
          try {
            const duration_minutes = body.duration_minutes || 60;
            const zoomResult = await createZoomForSession({
              tenantId,
              title: dbUpdates.title || existing.title,
              description: dbUpdates.description || existing.description,
              start_time: effectiveStartTime,
              duration_minutes,
              timezone: tz,
              zoom_type: effectiveZoomType,
              zoom_host_id: dbUpdates.zoom_host_id || existing.zoom_host_id,
              zoom_registration_required: dbUpdates.zoom_registration_required ?? existing.zoom_registration_required
            });

            if (zoomResult.error) {
              return res.status(500).json({ error: zoomResult.error });
            }

            Object.assign(dbUpdates, zoomResult.data);
          } catch (createErr) {
            console.error('[Sessions] Auto-create Zoom error:', createErr);
            return res.status(500).json({ error: 'Failed to create Zoom: ' + createErr.message });
          }
        }
      } else {
        if (existing.zoom_meeting_id && (dbUpdates.title || dbUpdates.start_time || dbUpdates.description)) {
          try {
            const token = await getZoomAccessTokenForTenant(tenantId);
            const zoomUpdates = {};
            if (dbUpdates.title) zoomUpdates.topic = dbUpdates.title;
            if (dbUpdates.start_time) zoomUpdates.start_time = dbUpdates.start_time;
            if (dbUpdates.description) zoomUpdates.agenda = dbUpdates.description;
            if (dbUpdates.timezone) zoomUpdates.timezone = dbUpdates.timezone;

            await fetch(`https://api.zoom.us/v2/meetings/${existing.zoom_meeting_id}`, {
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(zoomUpdates)
            });
            console.log('[Sessions] Synced meeting update to Zoom:', existing.zoom_meeting_id);
          } catch (e) {
            console.error('[Sessions] Failed to sync meeting to Zoom:', e.message);
          }
        }

        if (existing.zoom_webinar_id && (dbUpdates.title || dbUpdates.start_time || dbUpdates.description)) {
          try {
            const token = await getZoomAccessTokenForTenant(tenantId);
            const zoomUpdates = {};
            if (dbUpdates.title) zoomUpdates.topic = dbUpdates.title;
            if (dbUpdates.start_time) zoomUpdates.start_time = dbUpdates.start_time;
            if (dbUpdates.description) zoomUpdates.agenda = dbUpdates.description;
            if (dbUpdates.timezone) zoomUpdates.timezone = dbUpdates.timezone;

            await fetch(`https://api.zoom.us/v2/webinars/${existing.zoom_webinar_id}`, {
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(zoomUpdates)
            });
            console.log('[Sessions] Synced webinar update to Zoom:', existing.zoom_webinar_id);
          } catch (e) {
            console.error('[Sessions] Failed to sync webinar to Zoom:', e.message);
          }
        }
      }

      const { data: session, error: updateError } = await supabase
        .from('complex_event_session')
        .update(dbUpdates)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select(ADMIN_FIELDS)
        .single();

      if (updateError) {
        console.error('[Sessions] Update error:', updateError);
        return res.status(500).json({ error: 'Failed to update session' });
      }

      return res.json(session);
    } catch (error) {
      console.error('[Sessions] Update error:', error);
      return res.status(500).json({ error: error.message || 'Failed to update session' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { data: session, error: fetchError } = await supabase
        .from('complex_event_session')
        .select('id, complex_event_track_id, tenant_id, zoom_meeting_id, zoom_webinar_id')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (fetchError || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.zoom_meeting_id) {
        try {
          const token = await getZoomAccessTokenForTenant(tenantId);
          await fetch(`https://api.zoom.us/v2/meetings/${session.zoom_meeting_id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          console.log('[Sessions] Deleted Zoom meeting:', session.zoom_meeting_id);
        } catch (e) {
          console.error('[Sessions] Failed to delete Zoom meeting:', e.message);
        }
      }

      if (session.zoom_webinar_id) {
        try {
          const token = await getZoomAccessTokenForTenant(tenantId);
          await fetch(`https://api.zoom.us/v2/webinars/${session.zoom_webinar_id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          console.log('[Sessions] Deleted Zoom webinar:', session.zoom_webinar_id);
        } catch (e) {
          console.error('[Sessions] Failed to delete Zoom webinar:', e.message);
        }
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
