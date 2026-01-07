import { supabase } from '../../../_lib/database.js';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const { id } = req.query;

  if (req.method === 'GET') {
    try {
      const { data: meeting, error: meetingError } = await supabase
        .from('zoom_meeting')
        .select('*')
        .eq('id', id)
        .single();
      
      if (meetingError) {
        if (meetingError.code === 'PGRST116') {
          return res.status(404).json({ error: 'Meeting not found' });
        }
        return res.status(500).json({ error: meetingError.message });
      }
      
      return res.json(meeting);
    } catch (error) {
      console.error('[Zoom] Get meeting error:', error);
      return res.status(500).json({ error: error.message || 'Failed to get meeting' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const updates = req.body;
      
      const { data: existing, error: fetchError } = await supabase
        .from('zoom_meeting')
        .select('zoom_meeting_id')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Meeting not found' });
      }
      
      if (updates.topic || updates.start_time || updates.duration_minutes || updates.agenda || updates.timezone) {
        const token = await getZoomAccessToken();
        
        const zoomUpdates = {};
        if (updates.topic) zoomUpdates.topic = updates.topic;
        if (updates.start_time) zoomUpdates.start_time = updates.start_time;
        if (updates.duration_minutes) zoomUpdates.duration = updates.duration_minutes;
        if (updates.agenda) zoomUpdates.agenda = updates.agenda;
        if (updates.timezone) zoomUpdates.timezone = updates.timezone;
        
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/meetings/${existing.zoom_meeting_id}`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(zoomUpdates)
          }
        );
        
        if (!zoomResponse.ok && zoomResponse.status !== 204) {
          const errorText = await zoomResponse.text();
          console.error('[Zoom] Update meeting error:', errorText);
          return res.status(zoomResponse.status).json({ error: 'Failed to update Zoom meeting' });
        }
      }
      
      const { data: meeting, error: updateError } = await supabase
        .from('zoom_meeting')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      
      if (updateError) {
        console.error('[Zoom] DB update error:', updateError);
        return res.status(500).json({ error: 'Failed to update meeting' });
      }
      
      return res.json(meeting);
    } catch (error) {
      console.error('[Zoom] Update meeting error:', error);
      return res.status(500).json({ error: error.message || 'Failed to update meeting' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { deleteFromZoom = 'true' } = req.query;
      
      const { data: meeting, error: fetchError } = await supabase
        .from('zoom_meeting')
        .select('zoom_meeting_id')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Meeting not found' });
      }
      
      if (deleteFromZoom === 'true' && meeting.zoom_meeting_id) {
        const token = await getZoomAccessToken();
        
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/meetings/${meeting.zoom_meeting_id}`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        );
        
        if (!zoomResponse.ok && zoomResponse.status !== 204 && zoomResponse.status !== 404) {
          const errorText = await zoomResponse.text();
          console.error('[Zoom] Delete meeting error:', errorText);
          return res.status(zoomResponse.status).json({ error: 'Failed to delete from Zoom' });
        }
      }
      
      const { error: updateError } = await supabase
        .from('zoom_meeting')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', id);
      
      if (updateError) {
        console.error('[Zoom] DB update error:', updateError);
        return res.status(500).json({ error: 'Failed to cancel meeting' });
      }
      
      return res.json({ success: true });
    } catch (error) {
      console.error('[Zoom] Delete meeting error:', error);
      return res.status(500).json({ error: error.message || 'Failed to delete meeting' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
