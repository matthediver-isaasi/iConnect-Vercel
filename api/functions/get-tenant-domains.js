import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const ctx = await getTenantContext(req);
    if (!ctx.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tenantId = ctx.tenantId;
    if (!tenantId) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('id, name, slug, domain, status, settings')
      .eq('id', tenantId)
      .single();

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const domains = [];
    if (tenant.domain) {
      domains.push({
        name: tenant.domain,
        verified: true,
        type: 'primary'
      });
    }

    return res.status(200).json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        settings: tenant.settings
      },
      domains
    });

  } catch (err) {
    console.error('[Get Tenant Domains] Error:', err);
    return res.status(500).json({ error: 'Failed to get domain info' });
  }
}
