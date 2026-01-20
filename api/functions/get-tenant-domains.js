import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const member = await getSessionMember(req);
    if (!member) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { data: org } = await supabase
      .from('organization')
      .select('tenant_id')
      .eq('id', member.organization_id)
      .single();

    if (!org?.tenant_id) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('id, name, slug, domain, status, settings')
      .eq('id', org.tenant_id)
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
