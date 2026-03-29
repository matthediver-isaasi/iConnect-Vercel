import { supabase } from '../_lib/database.js';
import { getZoomAccessToken, getZoomAccessTokenForTenant, getTenantIdFromSession } from '../_lib/zoomClient.js';
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

  const ADMIN_LIST_FIELDS = 'id, complex_event_track_id, tenant_id, title, description, image_url, speaker_names, start_time, end_time, location, is_online, display_order, timezone, delivery_mode, zoom_type, zoom_meeting_id, zoom_webinar_id, zoom_join_url, zoom_start_url, zoom_host_id, zoom_host_email, zoom_registration_required, zoom_registration_url, created_at, updated_at';

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
        image_url,
        zoom_type,
        zoom_host_id,
        zoom_host_email,
        zoom_registration_required = false,
        auto_create_zoom = false,
        link_existing_zoom_id,
        link_existing_zoom_type
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

      const duration_minutes = req.body.duration_minutes || 60;

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
        timezone: timezone || null,
        zoom_type: delivery_mode === 'virtual' || delivery_mode === 'hybrid' ? (zoom_type || null) : null,
        zoom_host_id: zoom_host_id || null,
        zoom_host_email: zoom_host_email || null,
        zoom_registration_required
      };

      if (link_existing_zoom_id && (delivery_mode === 'virtual' || delivery_mode === 'hybrid')) {
        const effectiveZoomType = link_existing_zoom_type || zoom_type || 'meeting';
        try {
          const token = await getZoomAccessTokenForTenant(tenantId);
          const isWebinar = effectiveZoomType === 'webinar';
          const endpoint = isWebinar
            ? `https://api.zoom.us/v2/webinars/${link_existing_zoom_id}`
            : `https://api.zoom.us/v2/meetings/${link_existing_zoom_id}`;

          const zoomResponse = await fetch(endpoint, {
            headers: { 'Authorization': `Bearer ${token}` }
          });

          if (!zoomResponse.ok) {
            return res.status(400).json({ error: `Zoom ${effectiveZoomType} not found or not accessible` });
          }

          const zoomData = await zoomResponse.json();

          if (isWebinar) {
            sessionData.zoom_webinar_id = String(zoomData.id);
            sessionData.zoom_registration_url = zoomData.registration_url || null;
          } else {
            sessionData.zoom_meeting_id = String(zoomData.id);
          }
          sessionData.zoom_join_url = zoomData.join_url;
          sessionData.zoom_start_url = zoomData.start_url;
          sessionData.zoom_password = zoomData.password || null;
          sessionData.zoom_host_id = zoomData.host_id || zoom_host_id || null;
          sessionData.zoom_type = effectiveZoomType;

          if (!sessionData.start_time && zoomData.start_time) {
            sessionData.start_time = new Date(zoomData.start_time).toISOString();
          }
        } catch (linkErr) {
          console.error('[Sessions] Link existing Zoom error:', linkErr);
          return res.status(500).json({ error: 'Failed to link existing Zoom resource: ' + linkErr.message });
        }
      } else if (auto_create_zoom && (delivery_mode === 'virtual' || delivery_mode === 'hybrid') && zoom_type && start_time) {
        const zoomResult = await createZoomForSession({
          tenantId,
          req,
          title,
          description,
          start_time,
          duration_minutes,
          timezone,
          zoom_type,
          zoom_host_id,
          zoom_registration_required
        });

        if (zoomResult.error) {
          return res.status(500).json({ error: zoomResult.error });
        }

        Object.assign(sessionData, zoomResult.data);
      }

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

async function createZoomForSession({ tenantId, req, title, description, start_time, duration_minutes, timezone, zoom_type, zoom_host_id, zoom_registration_required }) {
  try {
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
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(meetingPayload)
      });

      if (!zoomResponse.ok) {
        const errorText = await zoomResponse.text();
        console.error('[Sessions] Zoom meeting create error:', errorText);
        return { error: `Failed to create Zoom meeting: ${errorText}` };
      }

      const zoomData = await zoomResponse.json();
      console.log('[Sessions] Zoom meeting created:', zoomData.id);

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
          auto_recording: 'cloud',
          enforce_login: false,
          close_registration: false,
          show_share_button: true,
          allow_multiple_devices: true,
          on_demand: true
        }
      };

      const zoomResponse = await fetch(`https://api.zoom.us/v2/users/${userId}/webinars`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(webinarPayload)
      });

      if (!zoomResponse.ok) {
        const errorText = await zoomResponse.text();
        console.error('[Sessions] Zoom webinar create error:', errorText);
        return { error: `Failed to create Zoom webinar: ${errorText}` };
      }

      const zoomData = await zoomResponse.json();
      console.log('[Sessions] Zoom webinar created:', zoomData.id);

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

    return { error: 'Invalid zoom_type. Must be "meeting" or "webinar".' };
  } catch (error) {
    console.error('[Sessions] Zoom create error:', error);
    return { error: error.message || 'Failed to create Zoom session' };
  }
}
