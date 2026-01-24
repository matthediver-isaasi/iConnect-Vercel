import { supabase } from '../../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../../_lib/zoomClient.js';

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

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.method === 'GET') {
    try {
      const { status, upcoming } = req.query;
      
      let query = supabase
        .from('zoom_meeting')
        .select('*')
        .order('start_time', { ascending: true });
      
      if (status) {
        query = query.eq('status', status);
      }
      
      if (upcoming === 'true') {
        query = query.gte('start_time', new Date().toISOString());
      }
      
      const { data, error } = await query;
      
      if (error) {
        console.error('[Zoom] List meetings error:', error);
        return res.status(500).json({ error: 'Failed to list meetings' });
      }
      
      return res.json(data || []);
    } catch (error) {
      console.error('[Zoom] List meetings error:', error);
      return res.status(500).json({ error: error.message || 'Failed to list meetings' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { 
        topic, 
        agenda, 
        start_time, 
        duration_minutes = 60, 
        timezone = 'Europe/London',
        host_id,
        created_by_member_id
      } = req.body;
      
      if (!topic || !start_time) {
        return res.status(400).json({ error: 'topic and start_time are required' });
      }
      
      const token = await getZoomAccessToken(req);
      
      let userId = host_id || 'me';
      
      const meetingPayload = {
        topic,
        type: 2,
        start_time: start_time,
        duration: duration_minutes,
        timezone,
        agenda: agenda || '',
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
      
      console.log('[Zoom] Creating meeting:', JSON.stringify(meetingPayload, null, 2));
      
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
        console.error('[Zoom] Create meeting error:', errorText);
        return res.status(zoomResponse.status).json({ 
          error: 'Failed to create Zoom meeting', 
          details: errorText 
        });
      }
      
      const zoomData = await zoomResponse.json();
      
      console.log('[Zoom] Meeting created:', zoomData.id);
      
      const { data: meeting, error: dbError } = await supabase
        .from('zoom_meeting')
        .insert({
          topic,
          agenda,
          start_time,
          duration_minutes,
          timezone,
          zoom_meeting_id: String(zoomData.id),
          zoom_host_id: zoomData.host_id,
          join_url: zoomData.join_url,
          start_url: zoomData.start_url,
          password: zoomData.password,
          status: 'scheduled',
          created_by_member_id
        })
        .select()
        .single();
      
      if (dbError) {
        console.error('[Zoom] DB save error:', dbError);
        return res.status(500).json({ error: 'Meeting created on Zoom but failed to save locally' });
      }
      
      return res.json({ success: true, meeting });
    } catch (error) {
      console.error('[Zoom] Create meeting error:', error);
      return res.status(500).json({ error: error.message || 'Failed to create meeting' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
