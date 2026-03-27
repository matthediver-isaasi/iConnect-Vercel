import { supabase } from '../../_lib/database.js';
import { getZoomAccessTokenForTenant } from '../../_lib/zoomClient.js';
import { getSessionTenantUser } from '../../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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

  try {
    const { data: session, error: sessionError } = await supabase
      .from('complex_event_session')
      .select('id, event_id, tenant_id, title, zoom_meeting_id, zoom_webinar_id, zoom_type, zoom_host_id, duration_minutes, timezone, start_time, end_time')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (sessionError || !session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const isWebinar = !!session.zoom_webinar_id;
    const isMeeting = !!session.zoom_meeting_id;

    if (!isWebinar && !isMeeting) {
      return res.status(400).json({ error: 'Session is not linked to a Zoom meeting or webinar' });
    }

    const token = await getZoomAccessTokenForTenant(tenantId);
    const zoomId = isWebinar ? session.zoom_webinar_id : session.zoom_meeting_id;
    const endpoint = isWebinar
      ? `https://api.zoom.us/v2/webinars/${zoomId}`
      : `https://api.zoom.us/v2/meetings/${zoomId}`;

    const zoomResponse = await fetch(endpoint, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!zoomResponse.ok) {
      if (zoomResponse.status === 404) {
        return res.status(404).json({ error: 'Zoom meeting/webinar not found (may have been deleted)' });
      }
      const errorText = await zoomResponse.text();
      console.error('[Sessions] Zoom sync error:', errorText);
      return res.status(500).json({ error: 'Failed to fetch from Zoom API' });
    }

    const zoomData = await zoomResponse.json();

    const zoomStartTime = new Date(zoomData.start_time).toISOString();
    const zoomEndTime = new Date(new Date(zoomData.start_time).getTime() + (zoomData.duration * 60 * 1000)).toISOString();

    const updateData = {
      start_time: zoomStartTime,
      end_time: zoomEndTime,
      duration_minutes: zoomData.duration,
      timezone: zoomData.timezone,
      zoom_join_url: zoomData.join_url || session.zoom_join_url,
      zoom_start_url: zoomData.start_url || session.zoom_start_url,
      updated_at: new Date().toISOString()
    };

    if (isWebinar && zoomData.registration_url) {
      updateData.zoom_registration_url = zoomData.registration_url;
    }

    const { error: updateError } = await supabase
      .from('complex_event_session')
      .update(updateData)
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (updateError) {
      console.error('[Sessions] Sync update error:', updateError);
      return res.status(500).json({ error: 'Failed to update session with Zoom data' });
    }

    console.log(`[Sessions] Synced session "${session.title}" with Zoom ${isWebinar ? 'webinar' : 'meeting'}`);

    return res.json({
      success: true,
      message: `Session synced with Zoom ${isWebinar ? 'webinar' : 'meeting'}`,
      updated: {
        start_time: zoomStartTime,
        end_time: zoomEndTime,
        duration_minutes: zoomData.duration,
        timezone: zoomData.timezone
      }
    });
  } catch (error) {
    console.error('[Sessions] Sync error:', error);
    return res.status(500).json({ error: error.message || 'Failed to sync session' });
  }
}
