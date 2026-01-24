import { supabase } from '../../../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../../../_lib/zoomClient.js';

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

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.query;

  try {
    const { name, email, role = 'panelist' } = req.body;
    
    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required' });
    }
    
    const { data: webinar, error: fetchError } = await supabase
      .from('zoom_webinar')
      .select('zoom_webinar_id, status, start_time')
      .eq('id', id)
      .single();
    
    if (fetchError) {
      return res.status(404).json({ error: 'Webinar not found' });
    }
    
    // Validate webinar is scheduled and upcoming
    if (webinar.status !== 'scheduled') {
      return res.status(400).json({ error: 'Can only add panelists to scheduled webinars' });
    }
    
    if (new Date(webinar.start_time) <= new Date()) {
      return res.status(400).json({ error: 'Can only add panelists to upcoming webinars' });
    }
    
    const token = await getZoomAccessToken(req);
    
    const zoomResponse = await fetch(
      `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/panelists`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          panelists: [{ name, email }]
        })
      }
    );
    
    if (!zoomResponse.ok) {
      const errorText = await zoomResponse.text();
      console.error('[Zoom] Add panelist error:', errorText);
      return res.status(zoomResponse.status).json({ error: 'Failed to add panelist to Zoom' });
    }
    
    const zoomData = await zoomResponse.json();
    // Zoom returns panelist ID inside the panelists array
    const zoomPanelistId = zoomData.panelists?.[0]?.id || zoomData.id;
    console.log('[Zoom] Panelist added, response:', JSON.stringify(zoomData));
    
    const { data: panelist, error: dbError } = await supabase
      .from('zoom_webinar_panelist')
      .insert({
        webinar_id: id,
        name,
        email,
        role,
        zoom_panelist_id: zoomPanelistId,
        status: 'invited'
      })
      .select()
      .single();
    
    if (dbError) {
      console.error('[Zoom] DB save panelist error:', dbError);
      return res.status(500).json({ error: 'Panelist added to Zoom but failed to save locally' });
    }
    
    return res.json(panelist);
  } catch (error) {
    console.error('[Zoom] Add panelist error:', error);
    return res.status(500).json({ error: error.message || 'Failed to add panelist' });
  }
}
