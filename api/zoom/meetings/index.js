import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

let zoomTokenCache = null;

async function getZoomAccessToken() {
  if (zoomTokenCache && Date.now() < zoomTokenCache.expiresAt - 60000) {
    return zoomTokenCache.token;
  }
  
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  
  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Zoom credentials not configured');
  }
  
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  
  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=account_credentials&account_id=${accountId}`
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Zoom] Token error:', errorText);
    throw new Error(`Failed to get Zoom access token: ${response.status}`);
  }
  
  const data = await response.json();
  
  zoomTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
  
  return data.access_token;
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
      
      const token = await getZoomAccessToken();
      
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
