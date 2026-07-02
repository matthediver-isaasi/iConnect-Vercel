import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { clearTenantZohoTokenCache } from '../_lib/zohoCampaignsClient.js';
import { clearTenantZohoCrmTokenCache } from '../_lib/zohoCrmClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const context = await getTenantContext(req);
    
    if (!context.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const isAdmin = await hasAdminAccess(context);
    const hasFeature = context.roleId ? await hasFeatureAccess(context.roleId, 'forms.due-diligence-config') : false;
    
    if (!isAdmin && !hasFeature) {
      return res.status(403).json({ error: 'Access denied - requires admin or due diligence config permission' });
    }

    const tenantId = context.tenantId;

    const { data: integration } = await supabase
      .from('tenant_integrations')
      .select('credentials')
      .eq('tenant_id', tenantId)
      .eq('integration_type', 'zoho_campaigns')
      .single();

    if (!integration) {
      return res.status(404).json({ error: 'No Zoho integration found' });
    }

    const existingCredentials = integration.credentials || {};
    const updatedCredentials = {
      client_id: existingCredentials.client_id,
      client_secret: existingCredentials.client_secret,
      region: existingCredentials.region,
      accounts_domain: existingCredentials.accounts_domain,
      campaigns_domain: existingCredentials.campaigns_domain
    };

    const { error } = await supabase
      .from('tenant_integrations')
      .update({
        credentials: updatedCredentials,
        updated_at: new Date().toISOString()
      })
      .eq('tenant_id', tenantId)
      .eq('integration_type', 'zoho_campaigns');

    if (error) {
      console.error('[Zoho] Disconnect error:', error);
      return res.status(500).json({ error: 'Failed to disconnect Zoho' });
    }

    // Clear in-memory token caches to ensure fresh tokens on reconnect
    clearTenantZohoTokenCache(tenantId);
    clearTenantZohoCrmTokenCache(tenantId);

    console.log('[Zoho] Disconnected for tenant:', tenantId);
    res.json({ success: true });
  } catch (error) {
    console.error('[Zoho] Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Zoho' });
  }
}
