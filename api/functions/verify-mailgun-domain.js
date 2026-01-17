import { getSessionTenantUser } from '../_lib/session.js';
import { verifyEmailDomain } from '../_lib/emailDomainService.js';

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

  console.log('[Verify Mailgun Domain] Handler invoked');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (tenantUser.role !== 'owner' && tenantUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden - requires owner or admin role' });
  }

  const tenantId = tenantUser.tenant_id;

  try {
    const result = await verifyEmailDomain(tenantId);

    if (!result.success) {
      return res.status(400).json({ 
        error: result.error,
        domain: result.domain 
      });
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error('[Verify Mailgun Domain] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to verify email domain',
      details: error.message 
    });
  }
}
