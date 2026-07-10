import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveMicrositeByPrefix } from '../_lib/microsites.js';
import { buildTenantBrandingPayload } from '../_lib/tenantBranding.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Host, X-Forwarded-Host');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const tenantData = await resolveTenantFromRequest(req);

    if (!tenantData) {
      console.log('[Tenant Branding] Tenant not found');
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Task #2426: microsite chrome. `?microsite=prefix` merges the
    // microsite's header/footer/logo over the tenant defaults so any field
    // the microsite leaves empty falls back to the tenant value.
    let microsite = null;
    const micrositePrefix = typeof req.query.microsite === 'string' ? req.query.microsite.trim() : '';
    if (micrositePrefix) {
      microsite = await resolveMicrositeByPrefix(supabase, tenantData.id, micrositePrefix);
      if (!microsite) {
        return res.status(404).json({ error: 'Microsite not found' });
      }
    }

    res.json({
      success: true,
      branding: buildTenantBrandingPayload(tenantData, microsite),
    });
  } catch (error) {
    console.error('[Tenant Branding] Error:', error);
    res.status(500).json({ error: 'Failed to fetch tenant branding' });
  }
}
