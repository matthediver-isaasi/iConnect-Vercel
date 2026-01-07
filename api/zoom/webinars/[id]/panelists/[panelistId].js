import { supabase } from '../../../../_lib/database.js';

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
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const { id, panelistId } = req.query;

  try {
    const { data: panelist, error: fetchError } = await supabase
      .from('zoom_webinar_panelist')
      .select('*, zoom_webinar!inner(zoom_webinar_id, status, start_time)')
      .eq('id', panelistId)
      .single();
    
    if (fetchError) {
      return res.status(404).json({ error: 'Panelist not found' });
    }
    
    // Validate webinar is scheduled and upcoming
    if (panelist.zoom_webinar.status !== 'scheduled') {
      return res.status(400).json({ error: 'Can only remove panelists from scheduled webinars' });
    }
    
    if (new Date(panelist.zoom_webinar.start_time) <= new Date()) {
      return res.status(400).json({ error: 'Can only remove panelists from upcoming webinars' });
    }
    
    if (panelist.zoom_panelist_id) {
      const token = await getZoomAccessToken();
      
      await fetch(
        `https://api.zoom.us/v2/webinars/${panelist.zoom_webinar.zoom_webinar_id}/panelists/${panelist.zoom_panelist_id}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );
    }
    
    const { error: deleteError } = await supabase
      .from('zoom_webinar_panelist')
      .delete()
      .eq('id', panelistId);
    
    if (deleteError) {
      console.error('[Zoom] DB delete panelist error:', deleteError);
      return res.status(500).json({ error: 'Failed to remove panelist' });
    }
    
    return res.json({ success: true });
  } catch (error) {
    console.error('[Zoom] Remove panelist error:', error);
    return res.status(500).json({ error: error.message || 'Failed to remove panelist' });
  }
}
