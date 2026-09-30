import { supabase } from '../_lib/database.js';
import { resolvePageTenant } from '../_lib/pageTenantResolver.js';
import { normalizeRoutePath, resolveUnknownPagePolicy } from '../_lib/unknownPagePolicy.js';

export function createRedirectResolver({ database = supabase, resolveTenant = resolvePageTenant } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (!database) return res.status(503).json({ error: 'Database not configured' });
    let path;
    try { path = normalizeRoutePath(req.query?.path); }
    catch { return res.status(400).json({ error: 'A valid local path is required' }); }
    try {
      const tenant = await resolveTenant(req);
      if (!tenant) return res.status(503).json({ error: 'Tenant could not be resolved' });
      return res.json(await resolveUnknownPagePolicy(database, tenant, path));
    } catch (error) {
      console.error('[Redirect Resolve] Resolution failed:', error.message);
      return res.status(503).json({ error: 'Page resolution is temporarily unavailable' });
    }
  };
}

export default createRedirectResolver();