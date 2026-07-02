import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  getOrCreateCrmWebhookSecret,
  regenerateCrmWebhookSecret
} from '../../_lib/zohoCrmClient.js';

export default async function handler(req, res) {
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
    const tenantId = ctx.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'Tenant context missing' });

    let secret;
    if (req.method === 'GET') {
      secret = await getOrCreateCrmWebhookSecret(tenantId);
    } else if (req.method === 'POST' && req.body?.action === 'regenerate') {
      secret = await regenerateCrmWebhookSecret(tenantId);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = (req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https'));
    const baseUrl = host ? `${proto}://${host}` : (process.env.APP_URL || '');
    const baseWebhookUrl = `${baseUrl}/api/zoho-crm/webhook?tenantId=${tenantId}`;
    const baseDeleteWebhookUrl = `${baseUrl}/api/zoho-crm/webhook/delete?tenantId=${tenantId}`;

    return res.status(200).json({
      tenant_id: tenantId,
      secret,
      base_url: baseWebhookUrl,
      example_urls: {
        Contacts: `${baseWebhookUrl}&module=Contacts`,
        Leads: `${baseWebhookUrl}&module=Leads`,
        Accounts: `${baseWebhookUrl}&module=Accounts`
      },
      // Delete webhook (task #450) is a separate endpoint so the upsert
      // path stays focused on full-record payloads. Reuses the same
      // per-tenant secret + tenantId scoping.
      delete_url: baseDeleteWebhookUrl,
      delete_example_urls: {
        Contacts: `${baseDeleteWebhookUrl}&module=Contacts`,
        Leads: `${baseDeleteWebhookUrl}&module=Leads`,
        Accounts: `${baseDeleteWebhookUrl}&module=Accounts`
      },
      header_name: 'X-Zoho-Webhook-Secret'
    });
  } catch (err) {
    console.error('[ZohoCrmSync webhook-url] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
