import { supabase } from '../../../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../../../_lib/zoomClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
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
  const email = req.query.email;

  if (!email) {
    return res.status(400).json({ error: 'Email parameter is required' });
  }

  try {
    // First get the webinar details to get the Zoom webinar ID
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
      return res.json({ join_url: null, message: 'Registration not required for this webinar' });
    }
    
    const accessToken = await getZoomAccessToken(req);
    
    // Fetch registrants from Zoom
    const zoomResponse = await fetch(
      `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants?page_size=300&status=approved`,
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
    const registrants = data.registrants || [];
    
    // Find the registrant with matching email (case-insensitive)
    const matchingRegistrant = registrants.find(
      r => r.email.toLowerCase() === email.toLowerCase()
    );
    
    if (!matchingRegistrant) {
      return res.json({ join_url: null, message: 'User not registered for this webinar' });
    }
    
    return res.json({
      join_url: matchingRegistrant.join_url,
      registrant_id: matchingRegistrant.id,
      status: matchingRegistrant.status
    });
  } catch (error) {
    console.error('[Zoom] Fetch join link error:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch join link' });
  }
}
