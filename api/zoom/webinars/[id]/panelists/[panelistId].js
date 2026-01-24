import { supabase } from '../../../../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../../../../_lib/zoomClient.js';

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

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
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
      const token = await getZoomAccessToken(req);
      
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
