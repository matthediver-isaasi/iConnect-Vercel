import { getTenantContext } from '../_lib/tenantContext.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { getOrCreateWebhookSecret, isZohoCampaignsConnected } from '../_lib/zohoCampaignsClient.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const context = await getTenantContext(req);
    
    if (!context.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tenantUser = await getSessionTenantUser(req);
    if (!tenantUser) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const tenantId = context.tenantId;

    const connected = await isZohoCampaignsConnected(tenantId);
    if (!connected) {
      return res.status(400).json({ 
        error: 'Zoho Campaigns not connected',
        message: 'Please connect Zoho Campaigns first'
      });
    }

    const secret = await getOrCreateWebhookSecret(tenantId);

    const host = req.headers.host || 'your-domain.com';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const webhookUrl = `${protocol}://${host}/api/zoho-campaigns/webhook?tenantId=${tenantId}&secret=${secret}`;

    return res.status(200).json({ 
      success: true,
      webhookUrl
    });

  } catch (error) {
    console.error('[ZohoCampaigns] Webhook URL error:', error);
    return res.status(500).json({ 
      error: 'Failed to generate webhook URL',
      details: error.message 
    });
  }
}
