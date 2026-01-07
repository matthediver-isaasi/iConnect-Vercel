import { supabase } from '../_lib/database.js';

let zoomTokenCache = null;

async function getZoomAccessToken() {
  if (zoomTokenCache && Date.now() < zoomTokenCache.expiresAt - 60000) {
    return zoomTokenCache.token;
  }
  
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  
  if (!accountId || !clientId || !clientSecret) {
    const missing = [];
    if (!accountId) missing.push('ZOOM_ACCOUNT_ID');
    if (!clientId) missing.push('ZOOM_CLIENT_ID');
    if (!clientSecret) missing.push('ZOOM_CLIENT_SECRET');
    throw new Error(`Zoom credentials not configured. Missing: ${missing.join(', ')}`);
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
    throw new Error(`Failed to get Zoom access token: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  console.log('[Zoom] Token scopes:', data.scope);
  
  zoomTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    scopes: data.scope
  };
  
  return data.access_token;
}

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

  // Force refresh token if requested
  if (req.query.refreshToken === 'true') {
    zoomTokenCache = null;
  }

  // Debug mode - show token scopes
  if (req.query.debug === 'true') {
    try {
      const token = await getZoomAccessToken();
      return res.json({ 
        success: true, 
        scopes: zoomTokenCache?.scopes || 'unknown',
        message: 'Token generated successfully'
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  try {
    const token = await getZoomAccessToken();
    
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
