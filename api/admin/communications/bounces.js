import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { loadBounces, resolveBounce } from '../../_lib/emailBounceService.js';

export function createBounceHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!['GET','POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    try {
      const ctx = await (deps.getTenantContext || getTenantContext)(req);
      if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (!ctx.tenantId || ctx.tenantMismatch) return res.status(403).json({ error: 'Invalid tenant context' });
      const feature = req.method === 'GET' && req.query?.memberId ? 'crm.members' : 'communication.management';
      const allowed = await (deps.hasAdminAccess || hasAdminAccess)(ctx) ||
        await (deps.hasFeatureAccess || hasFeatureAccess)(ctx.roleId, feature, ctx.memberExcludedFeatures || []);
      if (!allowed) return res.status(403).json({ error: 'Permission denied' });
      const db = deps.db || supabase;
      const result = req.method === 'GET'
        ? await (deps.loadBounces || loadBounces)(db, ctx.tenantId, req.query || {})
        : await (deps.resolveBounce || resolveBounce)(db, ctx, req.body || {});
      return res.status(200).json(result);
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.status ? error.message : 'Bounce management is unavailable. No addresses have been resumed.' });
    }
  };
}
export default createBounceHandler();
