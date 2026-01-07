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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const { id } = req.query;

  // GET - List registrants
  if (req.method === 'GET') {
    try {
      const { data: webinar, error: webinarError } = await supabase
        .from('zoom_webinar')
        .select('zoom_webinar_id, registration_required')
        .eq('id', id)
        .single();
      
      if (webinarError) {
        if (webinarError.code === 'PGRST116') {
          return res.status(404).json({ error: 'Webinar not found' });
        }
        return res.status(500).json({ error: webinarError.message });
      }
      
      if (!webinar.registration_required || !webinar.zoom_webinar_id) {
        return res.json({ registrants: [], total_records: 0 });
      }
      
      const accessToken = await getZoomAccessToken();
      
      const zoomResponse = await fetch(
        `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants?page_size=100`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (!zoomResponse.ok) {
        const errorText = await zoomResponse.text();
        console.error('[Zoom] Fetch registrants error:', errorText);
        return res.status(zoomResponse.status).json({ error: 'Failed to fetch registrants from Zoom' });
      }
      
      const data = await zoomResponse.json();
      
      return res.json({
        registrants: data.registrants || [],
        total_records: data.total_records || 0
      });
    } catch (error) {
      console.error('[Zoom] Fetch registrants error:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch registrants' });
    }
  }

  // POST - Add registrant
  if (req.method === 'POST') {
    try {
      const { first_name, last_name, email } = req.body;
      
      if (!first_name || !last_name || !email) {
        return res.status(400).json({ error: 'First name, last name, and email are required' });
      }
      
      const { data: webinar, error: fetchError } = await supabase
        .from('zoom_webinar')
        .select('zoom_webinar_id, registration_required, status, start_time')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Webinar not found' });
      }
      
      // Validate webinar is scheduled and upcoming
      if (webinar.status !== 'scheduled') {
        return res.status(400).json({ error: 'Can only add registrants to scheduled webinars' });
      }
      
      if (new Date(webinar.start_time) <= new Date()) {
        return res.status(400).json({ error: 'Can only add registrants to upcoming webinars' });
      }
      
      if (!webinar.registration_required) {
        return res.status(400).json({ error: 'Registration is not enabled for this webinar' });
      }
      
      if (!webinar.zoom_webinar_id) {
        return res.status(400).json({ error: 'Webinar not synced with Zoom' });
      }
      
      const token = await getZoomAccessToken();
      
      const zoomResponse = await fetch(
        `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            first_name,
            last_name,
            email,
            auto_approve: true
          })
        }
      );
      
      if (!zoomResponse.ok) {
        const errorData = await zoomResponse.json().catch(() => ({}));
        console.error('[Zoom] Add registrant error:', errorData);
        
        if (errorData.code === 3027) {
          return res.status(400).json({ error: 'This email is already registered for this webinar' });
        }
        
        return res.status(zoomResponse.status).json({ 
          error: errorData.message || 'Failed to add registrant to Zoom' 
        });
      }
      
      const zoomData = await zoomResponse.json();
      
      return res.json({
        id: zoomData.id,
        registrant_id: zoomData.registrant_id,
        start_time: zoomData.start_time,
        topic: zoomData.topic,
        first_name,
        last_name,
        email,
        status: 'approved'
      });
    } catch (error) {
      console.error('[Zoom] Add registrant error:', error);
      return res.status(500).json({ error: error.message || 'Failed to add registrant' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
