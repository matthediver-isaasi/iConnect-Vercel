import { getTenantContext } from '../_lib/tenantContext.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { getZohoCampaignsLists, isZohoCampaignsConnected } from '../_lib/zohoCampaignsClient.js';

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
      return res.status(200).json({ 
        connected: false, 
        lists: [],
        message: 'Zoho Campaigns not connected'
      });
    }

    const lists = await getZohoCampaignsLists(tenantId);
    
    return res.status(200).json({
      connected: true,
      lists
    });
  } catch (error) {
    console.error('[ZohoCampaigns] Lists error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch Zoho Campaigns lists',
      details: error.message 
    });
  }
}
