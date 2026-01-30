import { getTenantContext } from '../_lib/tenantContext.js';
import { getSessionTenantUser } from '../_lib/session.js';
import crypto from 'crypto';
import { 
  getZohoOAuthUrl, 
  connectZohoCampaigns, 
  isZohoCampaignsConnected 
} from '../_lib/zohoCampaignsClient.js';

const STATE_SECRET = process.env.SESSION_SECRET || process.env.INTERNAL_API_SECRET;

function generateSignedState(tenantId) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${tenantId}:${nonce}`;
  const signature = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  return `${payload}:${signature}`;
}

function validateSignedState(state) {
  if (!state || !STATE_SECRET) return null;
  const parts = state.split(':');
  if (parts.length !== 3) return null;
  
  const [tenantId, nonce, signature] = parts;
  const payload = `${tenantId}:${nonce}`;
  const expectedSignature = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    console.error('[ZohoCampaigns] Invalid OAuth state signature');
    return null;
  }
  
  return tenantId;
}

export default async function handler(req, res) {
  try {
    const context = await getTenantContext(req);

    if (req.method === 'GET') {
      const { action } = req.query;

      if (action === 'callback') {
        const { code, state, error } = req.query;

        if (error) {
          console.error('[ZohoCampaigns] OAuth error:', error);
          return res.redirect('/admin/communications?zoho_error=' + encodeURIComponent(error));
        }

        if (!code) {
          return res.redirect('/admin/communications?zoho_error=no_code');
        }

        const callbackTenantId = validateSignedState(state);
        if (!callbackTenantId) {
          console.error('[ZohoCampaigns] Invalid or tampered OAuth state');
          return res.redirect('/admin/communications?zoho_error=invalid_state');
        }

        const host = req.headers.host;
        const protocol = host?.includes('localhost') ? 'http' : 'https';
        const redirectUri = `${protocol}://${host}/api/zoho-campaigns/oauth?action=callback`;

        try {
          await connectZohoCampaigns(callbackTenantId, code, redirectUri);
          return res.redirect('/admin/communications?zoho_connected=true');
        } catch (err) {
          console.error('[ZohoCampaigns] OAuth callback error:', err);
          return res.redirect('/admin/communications?zoho_error=' + encodeURIComponent(err.message));
        }
      }

      if (!context.isAuthenticated) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const tenantUser = await getSessionTenantUser(req);
      if (!tenantUser) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const tenantId = context.tenantId;

      if (action === 'status') {
        const connected = await isZohoCampaignsConnected(tenantId);
        return res.status(200).json({ connected });
      }

      if (action === 'auth-url') {
        const host = req.headers.host;
        const protocol = host?.includes('localhost') ? 'http' : 'https';
        const redirectUri = `${protocol}://${host}/api/zoho-campaigns/oauth?action=callback`;
        
        const signedState = generateSignedState(tenantId);
        const authUrl = getZohoOAuthUrl(tenantId, redirectUri, signedState);
        return res.status(200).json({ authUrl });
      }

      return res.status(400).json({ error: 'Invalid action' });
    }

    if (req.method === 'POST') {
      if (!context.isAuthenticated) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const tenantUser = await getSessionTenantUser(req);
      if (!tenantUser) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { code, redirectUri } = req.body;

      if (!code || !redirectUri) {
        return res.status(400).json({ error: 'Missing code or redirectUri' });
      }

      await connectZohoCampaigns(context.tenantId, code, redirectUri);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('[ZohoCampaigns] OAuth error:', error);
    return res.status(500).json({ 
      error: 'OAuth error',
      details: error.message 
    });
  }
}
