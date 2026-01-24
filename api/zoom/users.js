import { supabase } from '../_lib/database.js';
import { getZoomAccessToken, getTenantIdFromSession } from '../_lib/zoomClient.js';

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

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Debug mode - show token scopes
  if (req.query.debug === 'true') {
    try {
      const token = await getZoomAccessToken(req);
      return res.json({ 
        success: true, 
        message: 'Token generated successfully'
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  try {
    const token = await getZoomAccessToken(req);
    
    const response = await fetch('https://api.zoom.us/v2/users?status=active', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Zoom] Users API error:', errorText);
      return res.status(response.status).json({ 
        error: 'Failed to fetch Zoom users',
        details: errorText,
        status: response.status
      });
    }
    
    const data = await response.json();
    return res.json(data.users || []);
  } catch (error) {
    console.error('[Zoom] Users error:', error);
    return res.status(500).json({ 
      error: error.message || 'Failed to fetch Zoom users',
      stack: error.stack
    });
  }
}
