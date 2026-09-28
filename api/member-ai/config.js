import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { loadTenantAiAssistantConfig } from '../_lib/tenantAiAssistant.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (ctx.tenantMismatch) return res.status(401).json({ error: 'Authentication required' });
    if (!ctx.tenantId) return res.status(400).json({ error: 'Tenant context required' });
    const config = await loadTenantAiAssistantConfig(ctx.tenantId);
    // Portal members need the public persona, not private tenant prompt instructions.
    // A tenantUserId in context alone is not authorization: verify the session now.
    const tenantUser = ctx.tenantUserId ? await getSessionTenantUser(req) : null;
    const adminTenantId = tenantUser?._sessionTenantId || tenantUser?.tenant_id;
    if (tenantUser && adminTenantId === ctx.tenantId && tenantUser.id === ctx.tenantUserId) {
      return res.status(200).json(config);
    }
    const { responsePolicy, ...publicConfig } = config;
    return res.status(200).json(publicConfig);
  } catch (error) {
    console.error('[Member AI Config] Error:', error);
    return res.status(503).json({ error: 'Assistant settings are unavailable.' });
  }
}