import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { provisionEmailDomain } from '../_lib/emailDomainService.js';

const ALLOWED_ORIGINS = ['https://iconn.app', 'https://www.iconn.app'];

function getAllowedOrigin(requestOrigin) {
  if (!requestOrigin) return ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  if (requestOrigin.endsWith('.iconn.app')) return requestOrigin;
  return ALLOWED_ORIGINS[0];
}

export default async function handler(req, res) {
  const origin = getAllowedOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log('[Provision Mailgun Domain] Handler invoked');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[Provision Mailgun Domain] Tenant user:', JSON.stringify({
    id: tenantUser.id,
    email: tenantUser.email,
    role: tenantUser.role,
    tenant_id: tenantUser.tenant_id,
    _isUnifiedIdentity: tenantUser._isUnifiedIdentity
  }));

  // Allow owner, admin roles - also treat null/undefined role as owner for legacy records
  const isAuthorized = tenantUser.role === 'owner' || tenantUser.role === 'admin' || !tenantUser.role;
  if (!isAuthorized) {
    return res.status(403).json({ error: 'Forbidden - requires owner or admin role' });
  }

  const tenantId = tenantUser.tenant_id;
  const { emailDomain: customEmailDomain } = req.body || {};

  try {
    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, slug, name, settings')
      .eq('id', tenantId)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Validate custom email domain if provided
    if (customEmailDomain) {
      const cleanDomain = customEmailDomain.toLowerCase().trim();
      if (!cleanDomain.includes('.') || cleanDomain.includes(' ')) {
        return res.status(400).json({ error: 'Invalid email domain format' });
      }
    }

    const result = await provisionEmailDomain(tenant.id, tenant.slug, tenant.name, tenant.settings, customEmailDomain);

    if (!result.success) {
      return res.status(500).json({ 
        error: 'Failed to provision email domain',
        details: result.error 
      });
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error('[Provision Mailgun Domain] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to provision email domain',
      details: error.message 
    });
  }
}
