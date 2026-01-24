import { getSessionTenantUser } from '../../_lib/session.js';
import { supabase } from '../../_lib/database.js';
import { decryptCredentials } from '../integrations.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantUser = await getSessionTenantUser(req);
  
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = tenantUser.tenant_id;

  try {
    const { data: integration, error } = await supabase
      .from('tenant_integrations')
      .select('credentials')
      .eq('tenant_id', tenantId)
      .eq('integration_type', 'zoom')
      .single();

    if (error || !integration) {
      return res.status(404).json({ 
        success: false, 
        error: 'Zoom integration not configured' 
      });
    }

    const credentials = decryptCredentials(integration.credentials);
    
    if (!credentials.account_id || !credentials.client_id || !credentials.client_secret) {
      return res.status(400).json({ 
        success: false, 
        error: 'Incomplete Zoom credentials' 
      });
    }

    const basicAuth = Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString('base64');
    
    const tokenResponse = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=account_credentials&account_id=${credentials.account_id}`
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('[Zoom Test] Token error:', errorText);
      return res.json({ 
        success: false, 
        error: 'Failed to authenticate with Zoom. Please check your credentials.' 
      });
    }

    const tokenData = await tokenResponse.json();
    
    const userResponse = await fetch('https://api.zoom.us/v2/users/me', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`
      }
    });

    if (!userResponse.ok) {
      return res.json({ 
        success: false, 
        error: 'Token obtained but failed to fetch user info' 
      });
    }

    const userData = await userResponse.json();

    console.log('[Zoom Test] Success for tenant:', tenantId);
    
    res.json({ 
      success: true, 
      message: 'Zoom connection successful!',
      account_email: userData.email,
      account_type: userData.type === 1 ? 'Basic' : userData.type === 2 ? 'Licensed' : 'Admin'
    });
  } catch (error) {
    console.error('[Zoom Test] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to test Zoom connection' 
    });
  }
}
